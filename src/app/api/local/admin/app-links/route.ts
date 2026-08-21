import { NextResponse } from 'next/server'
import { requireStaff, logStaffAction, clientIpOf } from '@/lib/local/staff'
import { getAppLinks, setAppLinks } from '@/lib/local/db'

// Admin: GET returns the current app store links; POST { ios, android } saves them.
// Backs the "App download links" card in the /ops console. That card lives on the
// console shell rather than a tab of its own, so it follows the 'overview' module.
export const dynamic = 'force-dynamic'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
// Store only valid http(s) URLs; anything else (incl. empty) clears the link.
function cleanUrl(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : null
  } catch {
    return null
  }
}

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'overview')
  if ('error' in gate) return gate.error
  try {
    return NextResponse.json(await getAppLinks(), { headers: CORS })
  } catch (err) {
    console.error('admin app-links GET:', err)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500, headers: CORS })
  }
}

export async function POST(req: Request) {
  const gate = await requireStaff(req, 'overview')
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => ({}))
    await setAppLinks(cleanUrl(body.ios), cleanUrl(body.android))
    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'app_links_updated',
      targetType: 'setting',
      targetId: 'app_links',
      detail: { ios: body?.ios ?? null, android: body?.android ?? null },
      ip: clientIpOf(req),
    })
    return NextResponse.json(await getAppLinks(), { headers: CORS })
  } catch (err) {
    console.error('admin app-links POST:', err)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500, headers: CORS })
  }
}

export function OPTIONS() {
  return new NextResponse(null, {
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' },
  })
}
