# QuickIn Backend

Standalone backend (API + data layer + admin) extracted from the QuickIn full-stack app.
Built with **Next.js 16** (App Router) route handlers over **node-postgres (`pg`)** — no Supabase,
no psql CLI in the request path. Deployable to Vercel/Neon or any Node host.

## Run

```bash
npm install
npm run dev        # API at http://localhost:4000
```

- `npm run build` — production build
- `npm run start` — serve the production build on :4000

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET  | `/api/local/listings` | All published listings. Filters: `?location=&guests=&checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD` |
| GET  | `/api/local/listings/[id]` | One listing by UUID (404 if missing) |
| POST | `/api/local/bookings` | Create a reservation (auth required) |
| GET  | `/api/local/bookings` | The signed-in user's reservations |
| POST | `/api/auth/signup` | Register (email + password) |
| POST | `/api/auth/login` | Sign in (email + password) |
| POST | `/api/auth/social` | Demo social sign-in (`google` / `apple`) |
| POST | `/api/auth/google` | Google sign-in — verifies a Google ID token against Google's JWKS |
| POST | `/api/auth/apple` | Sign in with Apple — verifies an identity token against Apple's JWKS |
| GET  | `/api/auth/me` | Resolve the current user (Bearer token or `qk_token` cookie) |
| GET  | `/api/auth/logout` | Clear the auth cookie |

All responses send `Access-Control-Allow-Origin: *`. Every POST route answers a CORS
preflight (`OPTIONS` → `204`) so browsers can call the API cross-origin.

Auth is stateless: an HMAC-signed token returned on login/signup, sent back either as a
`Bearer` header (mobile) or the `qk_token` cookie (web).

## Environment

| Var | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. Falls back to `postgresql://ahmedfarahat@127.0.0.1:5432/quickin_local` for local dev. Managed Postgres (Neon/Vercel/RDS) uses TLS automatically. |
| `AUTH_SECRET` | yes (prod) | Secret used to HMAC-sign auth tokens. Defaults to a dev secret — set a real one in production. |
| `GOOGLE_CLIENT_ID` | optional | Enables `/api/auth/google` (Google ID-token audience). |
| `APPLE_CLIENT_ID` | optional | Enables `/api/auth/apple` (Apple Services/bundle id). |

## Run the whole stack locally

Everything runs locally — no Vercel, no Neon, no SMTP account needed.

```bash
# 1. a local Postgres (any 14+)
brew services start postgresql@14
createdb quickin_local

# 2. build the ENTIRE schema + demo data + your admin login, one command
export DATABASE_URL=postgresql://localhost:5432/quickin_local
SUPERADMIN_EMAIL=you@quickin.app SUPERADMIN_PASSWORD='LocalDev12345' \
  node scripts/setup-local.mjs

# 3. run the apps (each in its own shell, DATABASE_URL exported in both)
npm run dev                                    # API      → :4000
cd ../../quickin-frontend && npm run dev       # web+/ops → :3000
```

Then sign in to the admin console at **http://localhost:3000/ops/login**.

`setup-local.mjs` is idempotent — re-run it any time to pick up new migrations. It
refuses to touch a non-local `DATABASE_URL` unless `ALLOW_REMOTE=1`, because it seeds
demo data.

> **`local-backend/init.sql` alone is NOT a working schema.** It creates the base
> tables, but 20+ later `scripts/migrate-*.mjs` files add columns and tables the apps
> actually read (`users.is_host`, `bookings.paid_at`, `host_applications`,
> `id_verifications`, …). A DB built from `init.sql` only will 500 on several
> endpoints. `setup-local.mjs` runs all of them in order.

Optional locally:

| Variable | Without it |
| --- | --- |
| `SMTP_*` | OTP and staff-reset codes are printed to the server console instead of emailed (the reset UI shows the code) |
| `STAFF_AUTH_SECRET` | Falls back to a dev default — fine locally, **set it in production** |
| `PAYMOB_*`, `FIREBASE_*` | Those features are inert |

### Seeding just the schema

```bash
psql "$DATABASE_URL" -f local-backend/init.sql   # base tables only — see the warning above
```

## Admin panel (optional)

A dependency-free admin UI (listings + users) lives in `local-backend/admin-server.mjs`
(uses the `psql` client directly). Run it separately:

```bash
node local-backend/admin-server.mjs   # http://localhost:3001
```
