import { NextResponse } from 'next/server'
import { listStaffAccounts, createStaffAccount, getStaffByEmail } from '@/lib/local/db'
import {
  requireSuperAdmin,
  hashStaffPassword,
  validateStaffPassword,
  normalizeModules,
  logStaffAction,
  clientIpOf,
} from '@/lib/local/staff'

// Staff account management (A2) — super admin only.
//   GET  /api/local/staff/accounts → { accounts: [...] }
//   POST /api/local/staff/accounts { email, password, full_name, role?, modules[] }
//
// Never returns password_hash: listStaffAccounts doesn't select it.
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireSuperAdmin(req)
  if ('error' in gate) return gate.error
  try {
    return NextResponse.json({ accounts: await listStaffAccounts() }, { headers: NO_STORE })
  } catch (err) {
    console.error('staff accounts GET:', err)
    return NextResponse.json({ error: 'Failed to load staff', detail: String(err) }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: Request) {
  const gate = await requireSuperAdmin(req)
  if ('error' in gate) return gate.error
  try {
    const body = await req.json().catch(() => ({}))
    const email = String(body.email ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    const fullName = String(body.full_name ?? body.fullName ?? '').trim()
    const role = body.role === 'super_admin' ? 'super_admin' : 'moderator'

    if (!email || !password || !fullName) {
      return NextResponse.json({ error: 'Email, name and password are required' }, { status: 400, headers: NO_STORE })
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ error: 'That is not a valid email address' }, { status: 400, headers: NO_STORE })
    }
    const bad = validateStaffPassword(password, email)
    if (bad) return NextResponse.json({ error: bad }, { status: 400, headers: NO_STORE })

    if (await getStaffByEmail(email)) {
      return NextResponse.json({ error: 'A staff account with that email already exists' }, { status: 409, headers: NO_STORE })
    }

    // Unknown and super-admin-only keys are dropped here, so a crafted request can't
    // grant 'staff' to a moderator. A super admin needs no rows at all.
    const modules = role === 'super_admin' ? [] : normalizeModules(body.modules)

    const account = await createStaffAccount({
      email,
      passwordHash: hashStaffPassword(password),
      fullName,
      role,
      createdBy: gate.staff.legacy ? null : gate.staff.staffId,
      modules,
    })

    await logStaffAction({
      staffId: gate.staff.legacy ? null : gate.staff.staffId,
      staffEmail: gate.staff.email,
      action: 'create_staff',
      targetType: 'staff_account',
      targetId: account.id,
      detail: { email, role, modules },
      ip: clientIpOf(req),
    })

    return NextResponse.json({ account }, { status: 201, headers: NO_STORE })
  } catch (err) {
    console.error('staff accounts POST:', err)
    return NextResponse.json({ error: 'Could not create the account', detail: String(err) }, { status: 500, headers: NO_STORE })
  }
}
