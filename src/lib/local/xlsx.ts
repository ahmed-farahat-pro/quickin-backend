// Excel (.xlsx) serialization for the /ops report exports (B4).
//
// Thin wrapper over `write-excel-file`, chosen over the npm `xlsx` package because
// SheetJS moved off npm and the stale registry copy carries known CVEs. The library
// is only reachable from a Node runtime, so any route importing this must declare
// `export const runtime = 'nodejs'`.
//
// Kept separate from analytics-core.ts on purpose: that module must stay
// import-free so `node --test` can load it. This one has a real dependency, so it
// lives here and takes plain primitives — no shared types needed.
import writeXlsxFile from 'write-excel-file/node'

/** A cell value we know how to write. Everything else is stringified. */
type Primitive = string | number | boolean | null | undefined

/** write-excel-file needs an explicit `type` per cell, or numbers land as text and
 *  Excel will not sum them. Dates are left as strings deliberately: the reports
 *  already format them as YYYY-MM-DD, and forcing a real date type would drag
 *  timezone handling into an export nobody asked to be timezone-aware. */
export function toCell(value: Primitive) {
  if (value === null || value === undefined) return { value: null }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { value, type: Number } : { value: null }
  }
  if (typeof value === 'boolean') return { value, type: Boolean }
  return { value: String(value), type: String }
}

/**
 * Build a single-sheet .xlsx.
 *
 * The header row is bolded and frozen so a long export stays readable while
 * scrolling — the one piece of formatting worth the bytes.
 */
export async function toXlsx(
  headers: readonly string[],
  rows: readonly (readonly Primitive[])[],
  { sheetName = 'Report' }: { sheetName?: string } = {}
): Promise<Buffer> {
  const data = [
    headers.map((h) => ({ value: String(h), fontWeight: 'bold' as const, type: String })),
    ...rows.map((r) => r.map(toCell)),
  ]

  // The node build always returns a writer ({ toBuffer, toStream, toFile }); there
  // is no `buffer: true` option in its types, and passing one is a no-op.
  const out = await writeXlsxFile(data as never, {
    // Excel rejects sheet names over 31 chars or containing : \ / ? * [ ]
    sheet: sheetName.replace(/[:\\/?*[\]]/g, '-').slice(0, 31) || 'Report',
    stickyRowsCount: 1,
  })
  return out.toBuffer()
}

/** RFC 6266 filename, ASCII-safe. A filename with a comma or quote in it breaks
 *  the Content-Disposition header in some browsers. */
export function attachmentName(base: string, ext: 'csv' | 'xlsx'): string {
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'report'
  return `${safe}.${ext}`
}
