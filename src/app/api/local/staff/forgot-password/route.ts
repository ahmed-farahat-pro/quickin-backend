import { NextResponse } from 'next/server'
import { getStaffByEmail, createStaffReset } from '@/lib/local/db'
import { rateLimit } from '@/lib/local/auth'
import { sendStaffResetEmail } from '@/lib/local/staff-email'
import { generateResetCode, logStaffAction, clientIpOf, RESET_TTL_MS } from '@/lib/local/staff'

// Step 1 of the staff password reset (A5).
//   POST /api/local/staff/forgot-password { email } → { sent: true }
//
// Always answers `{ sent: true }` — an unknown address, a deactivated account and a
// real send all look identical, so this cannot be used to enumerate staff emails.
// Issuing a code invalidates any earlier outstanding one (see createStaffReset).
// Locally, with no mail relay configured, the code is echoed back as `devCode`
// (the same convention as the guest forgot-password route).
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: Request) {
  const ip = clientIpOf(req)
  try {
    const wait = rateLimit(`staff-forgot:${ip}`, 10, 15 * 60_000)
    if (wait) {
      return NextResponse.json(
        { error: `Too many requests. Try again in ${wait}s.` },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(wait) } }
      )
    }

    const body = await req.json().catch(() => ({}))
    const email = String(body.email ?? '').trim()
    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400, headers: NO_STORE })
    }

    const staff = await getStaffByEmail(email)
    // Deactivated accounts get no code — reactivation is the super admin's call.
    if (!staff || !staff.is_active) {
      await logStaffAction({
        staffId: staff?.id ?? null,
        staffEmail: email,
        action: 'reset_requested_ignored',
        detail: { reason: staff ? 'inactive' : 'no_such_account' },
        ip,
      })
      return NextResponse.json({ sent: true }, { headers: NO_STORE })
    }

    const code = generateResetCode()
    await createStaffReset({ staffId: staff.id, email: staff.email, code, ttlMs: RESET_TTL_MS, ip })
    const minutes = Math.round(RESET_TTL_MS / 60_000)
    const delivered = await sendStaffResetEmail(staff.email, code, minutes)
    await logStaffAction({
      staffId: staff.id,
      staffEmail: staff.email,
      action: 'reset_requested',
      detail: { delivered },
      ip,
    })

    return NextResponse.json(
      { sent: true, ...(delivered ? {} : { devCode: code }) },
      { headers: NO_STORE }
    )
  } catch (err) {
    console.error('staff forgot-password:', err)
    return NextResponse.json({ error: 'Could not start the reset', detail: String(err) }, { status: 500, headers: NO_STORE })
  }
}
