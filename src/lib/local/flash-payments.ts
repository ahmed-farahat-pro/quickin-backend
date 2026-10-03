// Flash checkouts on Neon: start one for a booking, read where it stands, and
// apply what Flash reports — from the webhook or from a status poll, which may
// race each other and arrive in either order.
//
// The rules (what may transition to what, when a link is reusable, whether a
// payment covers the order) are in flash-core.ts and unit-tested there. This
// file is the SQL and the side effects around them. Schema:
// scripts/migrate-flash.mjs.
import { pool } from './pool'
import { getBookingById, getPaymentConfig } from './db'
import type { Booking } from './db'
import { canPay } from './payment-flow-core'
import { createNotification } from './notifications'
import { sendPush } from './push'
import {
  FLASH_MIN_AMOUNT_CENTS,
  FLASH_ORDER_VALIDITY_SECONDS,
  buildAggregatorOrderId,
  canReuseOrder,
  canTransition,
  isOpenFlashStatus,
  normalizeFlashStatus,
  paidEnough,
  toAmountCents,
} from './flash-core'
import type { FlashOrderView, FlashStatus } from './flash-core'
import { FlashApiError, cancelFlashOrder, createFlashOrder, getFlashOrder } from './flash'
import { randomBytes } from 'node:crypto'

/** A refusal the guest can understand; routes map `status` straight to HTTP. */
export class FlashCheckoutError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message)
    this.name = 'FlashCheckoutError'
  }
}

export function isFlashCheckoutError(e: unknown): e is FlashCheckoutError {
  return e instanceof Error && e.name === 'FlashCheckoutError'
}

interface FlashOrderRow {
  id: string
  booking_id: string
  user_id: string
  aggregator_order_id: string
  flash_order_id: string | null
  amount_cents: number
  payment_link: string | null
  status: string
  expires_at: string | null
  paid_at: string | null
  created_at: string
}

/** What the clients get back from both checkout calls. */
export interface FlashCheckoutView {
  /** pending | processing | succeeded | failed | canceled | refunded | expired | none */
  status: FlashStatus | 'none'
  /** True once the BOOKING is paid — by Flash or otherwise. The one field to stop polling on. */
  paid: boolean
  /** The hosted checkout to open, while it is still payable. */
  payment_link: string | null
  expires_at: string | null
  amount_cents: number | null
  order_id: string | null
}

const ROW_COLS = `id, booking_id, user_id, aggregator_order_id, flash_order_id, amount_cents::int AS amount_cents,
  payment_link, status,
  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at,
  to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS paid_at,
  created_at`

async function latestOrder(bookingId: string): Promise<FlashOrderRow | null> {
  const { rows } = await pool.query(
    `SELECT ${ROW_COLS} FROM flash_orders WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [bookingId],
  )
  return (rows[0] as FlashOrderRow) ?? null
}

function isPaid(b: Booking): boolean {
  return b.payment_status === 'paid' || !!b.paid_at
}

function view(row: FlashOrderRow | null, booking: Booking): FlashCheckoutView {
  const status = row ? normalizeFlashStatus(row.status) : 'none'
  const open = row ? isOpenFlashStatus(normalizeFlashStatus(row.status)) : false
  return {
    status,
    paid: isPaid(booking),
    payment_link: open ? row!.payment_link : null,
    expires_at: row?.expires_at ?? null,
    amount_cents: row ? Number(row.amount_cents) : null,
    order_id: row?.aggregator_order_id ?? null,
  }
}

async function ownBooking(bookingId: string, userId: string): Promise<Booking> {
  const b = await getBookingById(bookingId)
  if (!b || b.user_id !== userId) throw new FlashCheckoutError('Reservation not found', 404, 'not_found')
  return b
}

/**
 * Start (or resume) a Flash checkout for the guest's booking.
 *
 * Charges the COMMISSION-INCLUSIVE total — the same `total_price` every
 * guest-facing booking read shows — never the host's raw price.
 */
export async function startFlashCheckout(bookingId: string, userId: string): Promise<FlashCheckoutView> {
  let booking = await ownBooking(bookingId, userId)
  const cfg = await getPaymentConfig()
  if (!cfg.available_methods.includes('flash')) {
    throw new FlashCheckoutError('Card and wallet payments are not available right now', 409, 'flash_unavailable')
  }

  // A previous attempt may have been paid without us hearing yet (no webhook,
  // guest closed the tab). Settle it before deciding anything else, so a guest
  // can never be charged twice for one stay.
  const prior = await latestOrder(booking.id)
  if (prior && isOpenFlashStatus(normalizeFlashStatus(prior.status))) {
    await refreshFromFlash(prior).catch((e) => console.error('[flash] status refresh failed', e))
    booking = (await getBookingById(booking.id)) ?? booking
  }
  if (isPaid(booking)) return view(await latestOrder(booking.id), booking)
  if (!canPay({ ...booking, payment_state: booking.payment_status })) {
    throw new FlashCheckoutError('This reservation cannot be paid right now', 409, 'not_payable')
  }

  const amountCents = toAmountCents(booking.total_price)
  if (amountCents < FLASH_MIN_AMOUNT_CENTS) {
    throw new FlashCheckoutError('This amount is below the card-payment minimum', 400, 'below_minimum')
  }

  const latest = await latestOrder(booking.id)
  if (canReuseOrder(latest, amountCents, Date.now())) return view(latest, booking)

  // Close the old link before minting a new one, so there is only ever one
  // payable link per booking. Best-effort: if Flash already moved it on, the
  // read-back below records what really happened.
  if (latest && isOpenFlashStatus(normalizeFlashStatus(latest.status))) {
    await cancelFlashOrder(latest.aggregator_order_id, 'Superseded by a new checkout').catch(() => false)
    await refreshFromFlash(latest).catch(() => null)
    const again = await getBookingById(booking.id)
    if (again && isPaid(again)) return view(await latestOrder(booking.id), again)
  }

  const aggregatorOrderId = buildAggregatorOrderId(booking.id, Date.now(), randomBytes(3).toString('hex'))
  const guest = await pool.query(`SELECT full_name, phone FROM users WHERE id = $1`, [userId])
  let order: FlashOrderView
  try {
    order = await createFlashOrder({
      aggregatorOrderId,
      amountCents,
      bookingId: booking.id,
      reservationCode: booking.reservation_code,
      description: `QuickIn stay — ${booking.title ?? 'reservation'}${booking.reservation_code ? ` (${booking.reservation_code})` : ''}`,
      customerName: guest.rows[0]?.full_name ?? null,
      customerPhone: guest.rows[0]?.phone ?? null,
    })
  } catch (e) {
    if (e instanceof FlashApiError && e.code === 'ORDER_BELOW_MINIMUM') {
      throw new FlashCheckoutError('This amount is below the card-payment minimum', 400, 'below_minimum')
    }
    console.error('[flash] create order failed', e)
    throw new FlashCheckoutError('Could not start the card payment — please try again', 502, 'flash_error')
  }

  const { rows } = await pool.query(
    `INSERT INTO flash_orders (booking_id, user_id, aggregator_order_id, flash_order_id, amount_cents, payment_link, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', now() + make_interval(secs => $7))
     RETURNING ${ROW_COLS}`,
    [booking.id, userId, aggregatorOrderId, order.id, amountCents, order.paymentLink, FLASH_ORDER_VALIDITY_SECONDS],
  )
  return view(rows[0] as FlashOrderRow, booking)
}

/**
 * Where the guest's checkout stands. Asks Flash directly while it is open, so a
 * payment lands even if the webhook never arrives — the app polls this after
 * the guest comes back from the checkout page.
 */
export async function getFlashCheckout(bookingId: string, userId: string): Promise<FlashCheckoutView> {
  const booking = await ownBooking(bookingId, userId)
  const row = await latestOrder(booking.id)
  if (row && isOpenFlashStatus(normalizeFlashStatus(row.status))) {
    await refreshFromFlash(row).catch((e) => console.error('[flash] status refresh failed', e))
    const fresh = await getBookingById(booking.id)
    return view(await latestOrder(booking.id), fresh ?? booking)
  }
  return view(row, booking)
}

/** Read the order back from Flash and apply it. Local expiry if Flash has no news. */
async function refreshFromFlash(row: FlashOrderRow): Promise<void> {
  const remote = await getFlashOrder(row.aggregator_order_id)
  if (remote) {
    await applyFlashStatus(row.aggregator_order_id, remote, null)
    return
  }
  // Flash doesn't know it (shouldn't happen) — let it lapse at its own deadline.
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query(`UPDATE flash_orders SET status = 'expired', updated_at = now() WHERE id = $1 AND status IN ('pending','processing')`, [row.id])
  }
}

/**
 * Apply a status Flash reported for one of our orders. Idempotent and
 * order-insensitive: replaying a webhook, or a poll racing it, changes nothing
 * the second time. Returns false for an order we never created.
 *
 * Marks the booking paid in the same transaction as the order, and only when
 * the amount covers what the order was for.
 */
export async function applyFlashStatus(
  aggregatorOrderId: string,
  report: FlashOrderView,
  event: unknown,
): Promise<boolean> {
  const client = await pool.connect()
  let newlyPaid: { booking_id: string; user_id: string } | null = null
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, booking_id, user_id, amount_cents::int AS amount_cents, status
         FROM flash_orders WHERE aggregator_order_id = $1 FOR UPDATE`,
      [aggregatorOrderId],
    )
    const row = rows[0] as { id: string; booking_id: string; user_id: string; amount_cents: number; status: string } | undefined
    if (!row) { await client.query('ROLLBACK'); return false }

    const from = normalizeFlashStatus(row.status)
    let to = report.status
    if (to === 'succeeded' && !paidEnough(row.amount_cents, report.paidAmountCents)) {
      // A short payment is not a payment. Keep it visible for ops rather than
      // dropping it: the row says what Flash said, the booking stays unpaid.
      console.error('[flash] underpaid order', aggregatorOrderId, report.paidAmountCents, row.amount_cents)
      to = 'failed'
    }

    if (event !== null) {
      await client.query(`UPDATE flash_orders SET last_event = $2::jsonb, updated_at = now() WHERE id = $1`, [row.id, JSON.stringify(event)])
    }
    if (canTransition(from, to)) {
      await client.query(
        `UPDATE flash_orders SET status = $2, updated_at = now(),
                flash_order_id = COALESCE(flash_order_id, $3),
                paid_amount_cents = COALESCE($4, paid_amount_cents),
                paid_at = CASE WHEN $2 = 'succeeded' THEN COALESCE(paid_at, now()) ELSE paid_at END
          WHERE id = $1`,
        [row.id, to, report.id, report.paidAmountCents],
      )
      if (to === 'succeeded') {
        // `payment_status <> 'paid'` makes this the single place a booking flips,
        // so notifications below fire once however many reports arrive.
        const upd = await client.query(
          `UPDATE bookings SET payment_status = 'paid', payment_method = 'flash',
                  paid_at = COALESCE(paid_at, now())
            WHERE id = $1 AND COALESCE(payment_status, 'unpaid') <> 'paid'
            RETURNING id`,
          [row.booking_id],
        )
        if (upd.rowCount) newlyPaid = { booking_id: row.booking_id, user_id: row.user_id }
      }
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  if (newlyPaid) await announcePaid(newlyPaid.booking_id, newlyPaid.user_id).catch((e) => console.error('[flash] notify failed', e))
  return true
}

async function announcePaid(bookingId: string, guestId: string): Promise<void> {
  const b = await getBookingById(bookingId)
  const title = b?.title ?? 'your stay'
  await createNotification(guestId, {
    type: 'payment_approved',
    title: 'Payment confirmed',
    body: `Your booking for ${title} is fully confirmed.`,
    link: '/reservations',
  })
  await sendPush(guestId, { title: 'Booking confirmed 🎉', body: `${title} — payment received`, link: '/reservations' })
  if (b?.host_id) {
    await createNotification(b.host_id, {
      type: 'payment_approved',
      title: 'Guest paid',
      body: `${title} — the guest paid by card/wallet${b.reservation_code ? ` (${b.reservation_code})` : ''}`,
      link: '/host',
    })
    await sendPush(b.host_id, { title: 'Guest paid', body: `${title} — ${b.reservation_code ?? ''}`, link: '/host' })
  }
}
