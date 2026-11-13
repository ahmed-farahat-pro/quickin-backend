// Host contact — when a guest may see their host's phone number, and why a
// host must have one.
//
// A host's number is withheld while a guest browses, requests and waits. It is
// released on the booking itself once the stay is CONFIRMED AND PAID — not when
// the host accepts. Acceptance alone is not enough: an accepted-but-unpaid
// request would let a guest take the host's number and settle off-platform,
// which is exactly the leak contentguard keeps out of chat, names and bios.
//
// The rule is written twice, once as SQL (what BOOKING_COLS selects — so no
// booking read path can forget it) and once as a function (what the unit test
// pins). They must say the same thing; the test checks the SQL's literals too.
//
// Because guests are promised a number on every paid booking, hosts cannot be
// without one: a host may change their phone but never clear it, and approving
// a host application copies the application's phone onto the profile.
//
// No runtime imports, so `node --test` can import this file directly — see
// README → Testing. Callers import the core, never the reverse.

/** Booking statuses under which a paid stay releases the host's number. A
 *  completed stay keeps it, so a guest can still reach the host about a
 *  forgotten item; a cancelled/rejected one does not. */
export const HOST_PHONE_STATUSES = ['confirmed', 'completed'] as const

/** True when the guest on this booking may see the host's phone number. */
export function hostPhoneVisible(b: { status?: unknown; payment_status?: unknown }): boolean {
  const status = String(b.status ?? '')
  const paid = String(b.payment_status ?? 'unpaid') === 'paid'
  return paid && (HOST_PHONE_STATUSES as readonly string[]).includes(status)
}

/** The SQL twin of hostPhoneVisible. Expects `b` (bookings) in scope. A refund
 *  moves payment_status off 'paid', so a refunded booking hides it again. */
export const HOST_PHONE_VISIBLE_SQL =
  `(b.status IN (${HOST_PHONE_STATUSES.map((s) => `'${s}'`).join(', ')}) ` +
  `AND COALESCE(b.payment_status, 'unpaid') = 'paid')`

/** The refusal when a host tries to clear their phone. Whether an account is a
 *  host is read in SQL (getFullProfile → `phone_required`). */
export const HOST_PHONE_REQUIRED_MESSAGE =
  'Hosts must keep a phone number — guests reach you on it once their booking is paid'
