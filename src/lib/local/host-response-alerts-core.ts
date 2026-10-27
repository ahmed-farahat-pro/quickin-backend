// Host response alerts — the pure rules (no database, no network), so `node --test`
// can load them. host-response-alerts.ts holds the SQL and imports this; never the
// reverse.
//
// The feature: a guest's booking request that the host has neither accepted nor
// rejected after STALE_AFTER_HOURS becomes an alert in /ops, and the host gets a
// reminder each night it stays that way. A nightly sweep (01:00 UTC: 03:00 Cairo in winter, 04:00 in summer) does both.

/** A request older than this, still pending, is stale. */
export const STALE_AFTER_HOURS = 24

/**
 * Minimum gap between two reminders to the same host for the same request.
 * Not 24: Vercel fires a daily cron "within the hour", so two consecutive runs can
 * sit 23h-and-change apart, and a strict 24h gap would silently skip every other
 * night. 20h still guarantees at most one reminder per night, even if the cron is
 * re-run by hand.
 */
export const NUDGE_MIN_GAP_HOURS = 20

export const ALERT_STATUSES = ['open', 'handled', 'resolved', 'expired'] as const
export type AlertStatus = (typeof ALERT_STATUSES)[number]

/** Still the host's to answer: the sweep keeps these up to date and nudges for them. */
export const ACTIVE_STATUSES: readonly AlertStatus[] = ['open', 'handled']

/** What the /ops screen can ask for. `closed` = resolved + expired. */
export const LIST_FILTERS = ['open', 'handled', 'closed', 'all'] as const
export type ListFilter = (typeof LIST_FILTERS)[number]

export function normalizeListFilter(raw: unknown): ListFilter {
  const s = String(raw ?? '').trim().toLowerCase()
  return (LIST_FILTERS as readonly string[]).includes(s) ? (s as ListFilter) : 'open'
}

/** Statuses a filter selects. */
export function statusesFor(filter: ListFilter): AlertStatus[] {
  switch (filter) {
    case 'open': return ['open']
    case 'handled': return ['handled']
    case 'closed': return ['resolved', 'expired']
    default: return [...ALERT_STATUSES]
  }
}

const HOUR = 3_600_000

/**
 * Today's date in Cairo, YYYY-MM-DD. "Has the check-in passed?" is a question
 * about the guest's calendar, not UTC — between 22:00 and 00:00 UTC Cairo is
 * already on the next day.
 */
export function cairoDate(nowMs: number): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(nowMs))
}

/** Requests created at or before this instant are stale. */
export function staleCutoff(nowMs: number): Date {
  return new Date(nowMs - STALE_AFTER_HOURS * HOUR)
}

export function isStale(createdAt: string | Date | null | undefined, nowMs: number): boolean {
  if (!createdAt) return false
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return false
  return t <= staleCutoff(nowMs).getTime()
}

/** Whole hours a request has waited; 0 for anything unreadable or in the future. */
export function hoursWaiting(createdAt: string | Date | null | undefined, nowMs: number): number {
  if (!createdAt) return 0
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return 0
  return Math.max(0, Math.floor((nowMs - t) / HOUR))
}

/** Is this host due another reminder for this request? */
export function shouldNudge(lastNudgedAt: string | Date | null | undefined, nowMs: number): boolean {
  if (!lastNudgedAt) return true
  const t = new Date(lastNudgedAt).getTime()
  if (Number.isNaN(t)) return true
  return nowMs - t >= NUDGE_MIN_GAP_HOURS * HOUR
}

export type Closure = { status: 'resolved' | 'expired'; reason: string }

/**
 * Should an active alert close, and how?
 *
 *  - The booking left `pending` (host accepted/rejected, guest cancelled, an admin
 *    overrode it) → `resolved`, with the booking's status as the reason.
 *  - Still pending but the check-in date has passed → `expired`. The stay is
 *    already missed; "please answer" is noise at that point, and the host is not
 *    nudged about it either.
 *  - Otherwise null: still the host's to answer.
 *
 * `checkIn` and `today` are both YYYY-MM-DD, so string order is date order. A
 * check-in of TODAY is still answerable and stays open.
 */
export function closureFor(
  booking: { status: string | null | undefined; checkIn: string | null | undefined },
  today: string,
): Closure | null {
  const status = String(booking.status ?? '')
  if (status !== 'pending') return { status: 'resolved', reason: status || 'missing' }
  const checkIn = String(booking.checkIn ?? '').slice(0, 10)
  if (checkIn && checkIn < today) return { status: 'expired', reason: 'check_in_passed' }
  return null
}

/** Human label for `closed_reason`. */
export function closedReasonLabel(reason: string | null | undefined): string {
  switch (reason) {
    case 'confirmed': return 'Host accepted'
    case 'completed': return 'Stay completed'
    case 'rejected': return 'Host declined'
    case 'cancelled': return 'Cancelled'
    case 'check_in_passed': return 'Check-in date passed unanswered'
    case null: case undefined: case '': return ''
    default: return reason
  }
}

export class HostAlertInputError extends Error {}

export const HANDLED_NOTE_MAX = 500

/** The note an operator leaves when marking an alert handled. Required. */
export function normalizeHandledNote(raw: unknown): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!s) throw new HostAlertInputError('Add a note saying what you did (e.g. "called the host")')
  if (s.length > HANDLED_NOTE_MAX) {
    throw new HostAlertInputError(`Keep the note under ${HANDLED_NOTE_MAX} characters`)
  }
  return s
}

/** The reminder the host receives — in-app, push and email share it. */
export function nudgeCopy(listingTitle: string | null | undefined, hours: number) {
  const title = String(listingTitle ?? '').trim() || 'your listing'
  const waited = hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hours`
  return {
    title: 'A guest is waiting for your answer',
    body: `Your booking request for ${title} has waited ${waited}. Please accept or decline it.`,
  }
}
