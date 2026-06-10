// QuickIn API — status / index page (server component).
// Lists the available endpoints. Plain inline styles, no external CSS.

const BURGUNDY = '#5B0F16'
const CREAM = '#F6F1E6'
const TAN = '#EFE6D8'
const INK = '#2A2220'
const MUTED = '#6B6055'

interface Endpoint {
  method: string
  path: string
  desc: string
}

const ENDPOINTS: Endpoint[] = [
  { method: 'GET', path: '/api/local/listings', desc: 'All published listings (supports ?location=&guests=&checkIn=&checkOut=)' },
  { method: 'GET', path: '/api/local/listings/[id]', desc: 'A single listing by id' },
  { method: 'POST', path: '/api/local/bookings', desc: 'Create a reservation (auth required)' },
  { method: 'GET', path: '/api/local/bookings', desc: "The signed-in user's reservations" },
  { method: 'POST', path: '/api/auth/signup', desc: 'Register with email + password' },
  { method: 'POST', path: '/api/auth/login', desc: 'Sign in with email + password' },
  { method: 'POST', path: '/api/auth/social', desc: 'Demo social sign-in (google / apple)' },
  { method: 'POST', path: '/api/auth/google', desc: 'Google sign-in (verifies an ID token)' },
  { method: 'POST', path: '/api/auth/apple', desc: 'Sign in with Apple (verifies an identity token)' },
  { method: 'GET', path: '/api/auth/me', desc: 'Resolve the current user from token / cookie' },
  { method: 'GET', path: '/api/auth/logout', desc: 'Clear the auth cookie' },
]

const methodColor: Record<string, string> = {
  GET: '#177245',
  POST: BURGUNDY,
}

export default function Home() {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: CREAM,
        color: INK,
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        padding: '48px 24px',
      }}
    >
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <h1 style={{ margin: 0, fontSize: 36, color: BURGUNDY, letterSpacing: '-0.02em' }}>
          QuickIn <span style={{ fontWeight: 400, color: INK }}>API</span>
        </h1>
        <p style={{ color: MUTED, fontSize: 15, marginTop: 8 }}>
          Standalone backend — listings, bookings &amp; auth over node-postgres. No Supabase.
        </p>
        <div
          style={{
            display: 'inline-block',
            marginTop: 4,
            background: '#1772451a',
            color: '#177245',
            fontSize: 13,
            fontWeight: 600,
            padding: '4px 12px',
            borderRadius: 999,
          }}
        >
          ● Online
        </div>

        <h2 style={{ fontSize: 18, margin: '36px 0 14px', color: INK }}>Endpoints</h2>
        <div
          style={{
            background: '#fff',
            borderRadius: 18,
            overflow: 'hidden',
            boxShadow: '0 4px 16px rgba(42,34,32,.06)',
          }}
        >
          {ENDPOINTS.map((e, i) => (
            <div
              key={e.method + e.path}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 14,
                padding: '13px 18px',
                borderTop: i === 0 ? 'none' : `1px solid ${TAN}`,
              }}
            >
              <span
                style={{
                  flex: '0 0 52px',
                  fontSize: 12,
                  fontWeight: 700,
                  color: methodColor[e.method] || MUTED,
                }}
              >
                {e.method}
              </span>
              <span
                style={{
                  flex: '0 0 auto',
                  fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
                  fontSize: 14,
                  color: INK,
                  fontWeight: 600,
                }}
              >
                {e.path}
              </span>
              <span style={{ fontSize: 13, color: MUTED, marginLeft: 'auto', textAlign: 'right' }}>
                {e.desc}
              </span>
            </div>
          ))}
        </div>

        <p style={{ color: MUTED, fontSize: 13, marginTop: 28 }}>
          All responses send <code style={{ color: BURGUNDY }}>Access-Control-Allow-Origin: *</code>.
          POST routes accept a CORS preflight (<code style={{ color: BURGUNDY }}>OPTIONS</code> → 204).
        </p>
      </div>
    </main>
  )
}
