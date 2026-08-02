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
| GET  | `/api/local/payment-config` | The Instapay destination shown at checkout (auth required): `{instapay_handle, instructions, instapay_link, instapay_qr_image, qr_payload}` |
| GET  | `/api/local/admin/settings/instapay` | Read the same config for editing. Staff session with the `payments` module |
| PUT  | `/api/local/admin/settings/instapay` | Update it — `{instapay_handle?, instapay_link?, instapay_qr_image?, instructions?}`. Each field is optional: omit to leave untouched, send `""` to clear. `400` on an invalid link or QR |

All responses send `Access-Control-Allow-Origin: *`. Every POST route answers a CORS
preflight (`OPTIONS` → `204`) so browsers can call the API cross-origin.

Auth is stateless: an HMAC-signed token returned on login/signup, sent back either as a
`Bearer` header (mobile) or the `qk_token` cookie (web).

### The Instapay destination

Guests pay by transferring manually, so the number, QR code and link they see are all
admin-controlled — edited in the web ops panel at `/ops/payments` and stored as four
`app_settings` rows (`instapay_handle`, `instapay_instructions`, `instapay_link`,
`instapay_qr_image`). Validation lives in `src/lib/local/payment-config-core.ts`:
the link must be `http(s)` (it is rendered inside an anchor), and the QR must be a
PNG/JPEG/GIF/WebP data URL under ~500KB — SVG is rejected because it can carry markup.

`instapay_qr_image` holds the QR the admin uploaded, base64-inline like every other
World-1 image. When it is empty, clients draw their own QR from `qr_payload` (the link
if one is set, else the handle) — the web with `qrcode.react`, iOS with CoreImage — so
a guest always has something to scan. Nothing is stored twice: `qr_payload` is derived
on read, never persisted.

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

## Testing

**Every addition to this repo must be documented above and covered by a unit test.**

```bash
npm test          # offline unit tests — no database, no network, ~1s
npm run check     # parity guards + unit tests. Run before EVERY deploy of EITHER repo.
npm run test:watch
```

`node --test`, zero dependencies (Node 22 ships `node:test`, `node:assert` and native
`.ts` type-stripping).

| Path | What it is | Safe to run anytime? |
| --- | --- | --- |
| `test/unit/*.test.mjs` | **Unit tests.** Offline, assertion-based, what `npm test` runs. | Yes |
| `test/*.mjs` | **Live-HTTP smoke scripts that hit PRODUCTION** and write real rows. | **No** — run deliberately |
| `scripts/_guardtest.mjs` | The original offline guard (phone-number content filter). Included in `npm test`. | Yes |
| `scripts/check-*-parity.mjs` | Fail if a file duplicated across both repos has drifted. | Yes |

The scripts name `test/unit/*.test.mjs` explicitly rather than passing a directory —
Node treats *every* file under `test/` as a test file, so a bare `node --test` would
fire the production smoke scripts.

### Writing a testable module

Node's ESM resolver rejects the extension-less relative imports this codebase uses
(`import { pool } from './pool'`), so `db.ts`, `auth.ts` and friends **cannot be
imported by a test at all**. The rule that works around it:

> Pure logic lives in a `*-core.ts` module with **no runtime imports**. `db.ts`
> imports the core — never the reverse. A test then imports the core directly, with
> an explicit `.ts` extension.

`src/lib/local/resort-core.ts`, `payment-config-core.ts` and `contentguard.ts` are the
working examples.

Unit-test the pure cores: serializers, filter/clause builders, validators, money
math, normalizers. **Do not** build a mock-Postgres layer for the thin SQL wrappers —
their logic already lives in the cores, and they are covered by each migration's own
verification query plus the smoke scripts.

> **There is no CI.** No `.github/`, no `vercel.json` here — Vercel only runs
> `next build`, so a failing test cannot block a deploy. `npm run check` is a
> **manual gate**. Wiring it into a GitHub Action is the obvious next step.

## Database migrations

Every schema change is an idempotent script in `scripts/migrate-*.mjs`, run manually
against `DATABASE_URL`. `scripts/setup-local.mjs` runs all of them in order — that is
the list of record. Recent additions:

| Script | Adds |
| --- | --- |
| `migrate-staff-rbac.mjs` | `staff_accounts`, `staff_permissions`, `staff_sessions`, `staff_password_resets`, `staff_audit_log` — the `/ops` role system |
| `migrate-web-tables.mjs` | Tables and columns the web app reads that never had a script (`host_applications`, `id_verifications`, `otp_codes`, `saved_listings`, `conversations`, `chat_messages`, `users.is_host`/`host_type`, …) |
| `migrate-resorts.mjs` | `resorts`, `resort_aliases`, `resort_submissions`, `listings.resort_id`/`resort_name` — the curated compound catalog that replaces free-text location as the geographic filter |
| `migrate-analytics.mjs` | `bookings.cancelled_by`/`cancelled_by_role`/`cancellation_policy`/`commission_rate`/`refunded_at`, the `platform_commission_rate` setting, and the analytics indexes |
| `migrate-instapay.mjs` | `app_settings`, `payment_proofs`, and the four seeded `instapay_*` setting rows |

Apply a migration to Neon **before** deploying code that reads the new columns. The
reverse gap is safe — the columns are additive and unread until the deploy lands.

`app_settings` is the exception: it is a key/value table, `getPaymentConfig()` reads a
missing row as `''` and `setSetting()` upserts, so **adding a setting needs no
migration on an existing database** — the seeds in `migrate-instapay.mjs` are only
there so a freshly built local database starts with the rows present.

## Admin panel (optional)

A dependency-free admin UI (listings + users) lives in `local-backend/admin-server.mjs`
(uses the `psql` client directly). Run it separately:

```bash
node local-backend/admin-server.mjs   # http://localhost:3001
```
