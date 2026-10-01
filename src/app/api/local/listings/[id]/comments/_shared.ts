import { NextResponse } from 'next/server'
import { isContactBlockedError } from '@/lib/local/contentguard'
import { CommentError } from '@/lib/local/listing-comments'

// Shared by the listing-comment routes. Not a route itself — Next only treats
// `route.ts` as one.
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
}

export function preflight(methods: string) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': `${methods},OPTIONS`,
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  })
}

/** CommentError → its status; a contentguard refusal → 400 with its wording; else 500. */
export function commentErrorResponse(err: unknown, where: string) {
  if (err instanceof CommentError) {
    return NextResponse.json({ error: err.message }, { status: err.status, headers: CORS })
  }
  if (isContactBlockedError(err)) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400, headers: CORS })
  }
  console.error(where, err)
  return NextResponse.json({ error: 'Something went wrong' }, { status: 500, headers: CORS })
}
