// The Messages inbox is a UNION of two message stores, and this module is the
// seam that lets them share one list.
//
// QuickIn grew two independent threads between the same two people:
//
//   • `conversations` + `chat_messages` — the PRE-BOOKING thread, one per
//     (listing, guest). Opened by "Message host" on a listing.
//   • `messages` — the PER-RESERVATION thread, one per booking. Opened from a
//     reservation request, by either side.
//
// `GET /api/local/chat` only ever read the first one, so a host who replied
// inside a reservation request delivered a message the guest could not find:
// the inbox was empty and the only door was the reservation screen. That is the
// bug this module exists to close.
//
// The two stores are NOT merged into one scrollback. A guest can book the same
// listing twice, and a message about the March stay does not belong in the
// August one — so each reservation keeps its own thread and earns its own inbox
// row, labelled with the stay it is about.
//
// Namespacing is what makes one endpoint serve both: a reservation thread is
// addressed as `booking:<uuid>`, a pre-booking thread by its bare conversation
// uuid. Clients treat the id as opaque and hand it straight back, which is why
// iOS, Android and the web all pick this up without knowing two stores exist.
//
// Pure — no imports, no I/O. See README → Testing.

/** Namespace marker for a per-reservation thread id. */
export const BOOKING_THREAD_PREFIX = 'booking:'

/** How many threads the inbox returns. Matches the pre-existing per-store cap. */
export const INBOX_LIMIT = 200

export type ThreadKind = 'listing' | 'booking'

/** A parsed inbox thread id: which store it lives in, and the row's real uuid. */
export interface ThreadRef {
  kind: ThreadKind
  /** conversation uuid for `listing`, booking uuid for `booking`. */
  id: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The inbox id for a reservation thread. */
export function bookingThreadId(bookingId: string): string {
  return `${BOOKING_THREAD_PREFIX}${bookingId}`
}

/**
 * Resolve an id a client sent back to the store it addresses, or `null` when it
 * is neither. Anything that isn't a well-formed uuid is rejected here rather
 * than reaching a query — the callers used to lean on `isUuid` for that, and the
 * prefix would have slipped straight past it.
 */
export function parseThreadId(raw: unknown): ThreadRef | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  if (value.toLowerCase().startsWith(BOOKING_THREAD_PREFIX)) {
    const id = value.slice(BOOKING_THREAD_PREFIX.length)
    return UUID_RE.test(id) ? { kind: 'booking', id } : null
  }
  return UUID_RE.test(value) ? { kind: 'listing', id: value } : null
}

/**
 * One inbox row, whichever store it came from. The pre-booking fields are the
 * ones the clients already render; `kind` and the reservation fields are added,
 * never substituted, so a client build that predates this change keeps working
 * and simply doesn't draw the stay dates.
 */
export interface InboxThread {
  id: string
  kind: ThreadKind
  /** Only on `booking` rows — the reservation the thread belongs to. */
  booking_id: string | null
  listing_id: string | null
  listing_title: string | null
  listing_image: string | null
  other_name: string | null
  last_message: string | null
  last_message_at: string | null
  is_host: boolean
  /** Only on `booking` rows — the stay, so two threads about one listing differ. */
  check_in: string | null
  check_out: string | null
  booking_status: string | null
}

/** The shape either query returns before it is tagged and sorted. */
export type InboxThreadRow = Partial<InboxThread> & { id: string }

function normalize(row: InboxThreadRow, kind: ThreadKind): InboxThread {
  return {
    id: row.id,
    kind,
    booking_id: kind === 'booking' ? (row.booking_id ?? null) : null,
    listing_id: row.listing_id ?? null,
    listing_title: row.listing_title ?? null,
    listing_image: row.listing_image ?? null,
    other_name: row.other_name ?? null,
    last_message: row.last_message ?? null,
    last_message_at: row.last_message_at ?? null,
    is_host: Boolean(row.is_host),
    check_in: kind === 'booking' ? (row.check_in ?? null) : null,
    check_out: kind === 'booking' ? (row.check_out ?? null) : null,
    booking_status: kind === 'booking' ? (row.booking_status ?? null) : null,
  }
}

/**
 * Interleave the two stores into the single newest-first list the inbox shows.
 *
 * Sorting in code rather than in one UNION query: the two SELECTs have almost
 * nothing in common (different tables, different joins, different membership
 * rules), and a union of them would have to pad both sides with NULL columns to
 * line up — a shape that breaks silently the next time either side gains a
 * column. This way each query stays readable and the ordering is testable.
 *
 * Timestamps are compared as strings on purpose: both sides format them as
 * `YYYY-MM-DDTHH:MM:SSZ`, where lexicographic and chronological order agree.
 * A row with no timestamp sorts last rather than jumping to the top.
 */
export function mergeInboxThreads(
  listingThreads: InboxThreadRow[],
  bookingThreads: InboxThreadRow[],
  limit: number = INBOX_LIMIT
): InboxThread[] {
  const merged = [
    ...(listingThreads ?? []).map((r) => normalize(r, 'listing')),
    ...(bookingThreads ?? []).map((r) => normalize(r, 'booking')),
  ]
  const seen = new Set<string>()
  return merged
    .filter((t) => {
      if (!t.id || seen.has(t.id)) return false
      seen.add(t.id)
      return true
    })
    .sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''))
    .slice(0, Math.max(0, limit))
}
