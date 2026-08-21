import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/local/staff'
import { listResortSubmissions, previewResortMerge } from '@/lib/local/resorts'

// The moderation queue for host-typed ("Other") resort names.
//   GET /api/local/admin/resorts/submissions[?status=pending|approved|rejected]
//   GET /api/local/admin/resorts/submissions?preview=<raw name>
//       → the listings a merge of that name would relink, so the admin sees the
//         blast radius before committing.
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: Request) {
  const gate = await requireStaff(req, 'resorts')
  if ('error' in gate) return gate.error
  try {
    const sp = new URL(req.url).searchParams
    const preview = sp.get('preview')
    if (preview) return NextResponse.json({ listings: await previewResortMerge(preview) }, { headers: NO_STORE })

    const status = sp.get('status') ?? 'pending'
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return NextResponse.json({ error: 'status must be pending, approved or rejected' }, { status: 400, headers: NO_STORE })
    }
    return NextResponse.json({ submissions: await listResortSubmissions(status) }, { headers: NO_STORE })
  } catch (err) {
    console.error('admin resort submissions GET:', err)
    return NextResponse.json({ error: 'Failed to load the queue', detail: String(err) }, { status: 500, headers: NO_STORE })
  }
}
