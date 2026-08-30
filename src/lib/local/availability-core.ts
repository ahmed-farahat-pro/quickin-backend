// Which bookings hold a listing's dates — the single rule behind every calendar,
// every search filter and the clash check that refuses a reservation.
//
// Pure, and DELIBERATELY free of runtime imports, so `node --test` can load it
// directly. db.ts imports this; never the reverse. See README → Testing.
//
// The rule, in one line: **only an ACCEPTED stay holds dates.**
//
// It used to be "anything that isn't cancelled" (and, in a couple of places,
// "anything that isn't cancelled or rejected"), which quietly handed the dates to
// whoever asked FIRST rather than to whoever the host actually said yes to. Guest
// A sends a request, the host has not looked at it yet, and Guest B is already
// told the chalet is taken — for a stay that may never happen. A request is an
// ask, not a claim; the host's acceptance is what turns it into one.

/** `bookings.status` values that make a night unavailable to everyone else.
 *
 *  - `pending`   — a REQUEST. Holds nothing: any number of guests may ask for the
 *                  same nights, and the host picks one.
 *  - `confirmed` — the host said yes. This is what holds the dates.
 *  - `completed` — a stay that already happened; it still owns its nights.
 *  - `rejected` / `cancelled` — over. They never hold anything. */
export const DATE_HOLDING_STATUSES = ['confirmed', 'completed'] as const
export type DateHoldingStatus = (typeof DATE_HOLDING_STATUSES)[number]

/** Does a booking in this status take its nights off the market? */
export function holdsDates(status: unknown): boolean {
  const v = String(status ?? '').trim().toLowerCase()
  return (DATE_HOLDING_STATUSES as readonly string[]).includes(v)
}

/**
 * The same rule as SQL, so no query can spell it differently. `alias` is the
 * table alias the `status` column hangs off (`''` for an unaliased `FROM bookings`).
 *
 * Written from DATE_HOLDING_STATUSES rather than typed out, so the list can never
 * disagree with `holdsDates`.
 */
export function holdsDatesSql(alias = 'b'): string {
  const col = alias ? `${alias}.status` : 'status'
  return `${col} IN (${DATE_HOLDING_STATUSES.map((s) => `'${s}'`).join(', ')})`
}

/**
 * Do two half-open date ranges [start, end) collide?
 *
 * Half-open is what makes a same-day turnover legal: one guest checking out on the
 * 10th and another checking in on the 10th do NOT overlap. ISO `YYYY-MM-DD`
 * strings compare correctly, which is why the SQL can use the same `<` / `>`.
 */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && aEnd > bStart
}

/**
 * Thrown when dates that were free when the guest asked are not free any more —
 * the host accepting a second request over nights they already gave away, or
 * accepting one over a range they have since blocked on their own calendar.
 *
 * Its own type because the caller has to answer `409`, not `500`: nothing is
 * broken, the answer is simply no.
 */
export class BookingConflictError extends Error {
  constructor(message = 'Those dates are no longer available') {
    super(message)
    this.name = 'BookingConflictError'
  }
}
