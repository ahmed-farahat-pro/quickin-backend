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
| —    | *(all auth routes above)* | A **blocked or removed** account is refused with **403 `{ error, accountStatus }`** — deliberately **without** `needsVerification`, so the apps show the message instead of routing to the OTP screen. See Account status below |
| DELETE | `/api/local/admin/users/:id` | **410 Gone** — hard delete is retired. Block or remove the account in `/ops` → Users |
| GET  | `/api/auth/logout` | Clear the auth cookie |
| GET  | `/api/local/payment-config` | The Instapay destination shown at checkout (auth required): `{instapay_handle, instructions, instapay_link, instapay_qr_image, qr_payload}` |
| GET  | `/api/local/admin/settings/instapay` | Read the same config for editing. Staff session with the `payments` module |
| PUT  | `/api/local/admin/settings/instapay` | Update it — `{instapay_handle?, instapay_link?, instapay_qr_image?, instructions?}`. Each field is optional: omit to leave untouched, send `""` to clear. `400` on an invalid link or QR |
| GET  | `/api/local/host/listing-gate` | May this host add a listing — `{allowed, code, message, reason}`. Same `code` the create route returns on 403, so the apps can refuse up front. `reason` only on a rejection |
| GET  | `/api/local/host/commission` | The platform commission — `{rate, percent}` — so the add/edit-listing screens can show a host what guests will pay. Auth required (a guest holding the rate could divide out the host's raw price) |
| GET  | `/api/local/admin/settings/commission` | The platform commission — `{rate, percent, updated_at, updated_by}`. Staff session with the `pricing` module |
| PUT  | `/api/local/admin/settings/commission` | Set it — `{percent}` (e.g. `12.5`). `400` outside 0–100. Reprices every listing and service immediately; existing bookings keep their snapshotted rate |

All responses send `Access-Control-Allow-Origin: *`. Every POST route answers a CORS
preflight (`OPTIONS` → `204`) so browsers can call the API cross-origin.

Auth is stateless: an HMAC-signed token returned on login/signup, sent back either as a
`Bearer` header (mobile) or the `qk_token` cookie (web).

### Host identity verification

A host must be **both** an approved host (`users.is_host`, or the legacy `users.role='host'`)
**and** identity-verified (`users.verification_status`) before they can create or publish a
listing. `canPublishListing()` in `src/lib/local/host-verification-core.ts` is the single
place those two facts are combined; every refusal carries a `code`
(`not_host` | `verification_missing` | `verification_pending` | `verification_rejected`)
that web, iOS and Android switch on to pick a call to action. Clients must never parse the
message — the wording is server-owned so all three say the same thing.

The gate bites in three places:

| Where | What happens |
| --- | --- |
| `POST /api/local/listings` | 403 `{error, code}` — on **both** projects. The web route previously required only a session, so any signed-in guest could create a listing there |
| `setListingApproval(id, true)` | Throws rather than publishing an unverified host's listing. A listing can outlive the verification that allowed it, and going live is the moment that matters |
| `GET /api/local/host/listing-gate` | Advisory — lets the apps and `/host/new` refuse before the host fills in a whole listing |

**Losing verification unpublishes.** `reviewVerification` compares the old status to the new
one and, when a verified host stops being verified (including re-opening a decided case),
takes their published listings down, flagged with `listings.unpublished_by_verification` so
re-verifying restores exactly those. That flag is deliberately **separate** from the account
block's `unpublished_by_admin`: sharing one would let unblocking an account republish
listings verification had hidden. The two reasons compose — hidden for both stays hidden
until both clear.

**Identity is folded into the host application.** The apply form submits the ID documents
with the application (`doc_type` + front/back/selfie), linked by
`host_applications.verification_id`, so one admin decision in /ops approves host status
*and* identity. They used to be two requests, the second fired after the first succeeded —
so a failed upload left an application on file with no ID attached. The standalone
`/verify-id` path stays: verification is open to any signed-in user (guests verify for the
trust badge), and already-approved hosts need it to satisfy the cutover.

### The platform commission

QuickIn takes its cut as a **markup**, not a fee. A host names the price they want to
receive; a guest is quoted `raw × (1 + rate)`, rounded **up to the nearest 10 EGP**.
The commission is never itemised — the guest sees one inclusive price, and the host is
paid their full raw price.

This replaced the older fee model, which charged the guest a 10% service fee *and*
withheld 10% from the host, plus a ±5% card/bank-transfer adjustment that stopped
meaning anything once Instapay became the only method. `serviceFee` and `methodFee`
still appear on the pay receipt as hardcoded **zeros**, purely so already-installed
mobile builds — whose decoders require those keys — don't fail to parse a receipt.
Delete them once those builds are retired.

The rate is one `app_settings` row, `platform_commission_rate`, stored as a fraction
(`'0.1'` = 10%) and edited at `/ops/pricing` behind the `pricing` staff module.

**Guest prices are derived at read time, never stored**, so changing the rate reprices
the whole catalogue at once with no backfill and nothing to drift. The one thing that
*is* stored is `bookings.commission_rate`: every booking snapshots the rate it was
taken at, so a rate change can never restate a reservation a guest already agreed to.

Which price a query returns is decided by the **projection**, not by the caller
remembering to convert:

| | `price_per_night` / `total_price` | Extra fields |
| --- | --- | --- |
| `LISTING_COLS`, `BOOKING_COLS`, `SERVICE_COLS` (guest) | commission-inclusive | — (the raw price is never sent to a guest) |
| `LISTING_COLS_HOST`, `SERVICE_COLS_HOST` | the host's raw price | `guest_price_per_night`, `guest_weekend_price`, `guest_monthly_prices` |
| `getHostBookings` | commission-inclusive | `host_payout` — the raw amount owed |

The host projection returns the **raw** price on purpose: the edit form loads that
field and PATCHes it straight back, so returning the marked-up figure there would
inflate the listing a little more on every save. `getListingById(id, { asHost: true })`
selects it; every write path already does.

The formula and its rounding rule live in `src/lib/local/commission-core.ts`, in both
TypeScript **and** SQL (`sqlWithCommission()`), because the markup has to run inside
Postgres too — for the price filter and the per-night stay sum. `scripts/_verify-commission.mjs`
runs both against a local database and asserts they agree to the pound; the file is
byte-identical in the web repo, guarded by `scripts/check-commission-core-parity.mjs`.

**Reporting the platform's margin.** Two more SQL builders live in the same file, for
any query that has to say what QuickIn actually earned:

| Builder | Yields |
| --- | --- |
| `bookingRateSql(alias)` | `COALESCE(<alias>.commission_rate, <live rate>)` — the booking's own snapshot, never the live rate for a booking that already has one |
| `bookingCommissionSql(alias)` | the cut in EGP: **guest price − raw price**, floored at zero |

The margin is deliberately **not** `total_price × rate`. The guest price rounds up to
the nearest 10 EGP, so the true cut sits a few pounds above the flat percentage, and a
percentage would never reconcile against what the guest was charged. Anything reporting
commission — the `/ops` dashboard tiles, the bookings table, the analytics revenue
report, the CSV export — goes through these, so all four agree by construction.

One subtlety worth keeping: `raw * (1 + rate)` is binary-float, so `100 × 1.1` is
`110.00000000000001` and a naive `ceil` would bill 120. `roundUpToStep()` settles to
piasters before rounding up.

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
| `scripts/_guardtest.mjs` | The original offline guard script (phone numbers only). Superseded by `test/unit/contentguard.test.mjs`; kept because it still passes and costs nothing. | Yes |
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

`src/lib/local/resort-core.ts`, `payment-config-core.ts`, `contentguard.ts`,
`moderation-core.ts`, `disputes-core.ts` and `account-status-core.ts` are the
working examples.

`account-status-core.ts` is the one core that is **not** parity-guarded, on purpose.
It is a deliberately smaller sibling of the web project's `user-admin-core.ts`: only
`/ops` *writes* account status, this project only *reads* it, so all that lives here
is the predicate, the rejection copy and the mobile response contract. Guarding it
would make every future edit a mandatory two-repo commit for no correctness gain. What
does matter — that a blocked login is a `403` carrying no `needsVerification` key — is
locked by `test/unit/account-status-core.test.mjs`.

Unit-test the pure cores: serializers, filter/clause builders, validators, money
math, normalizers. **Do not** build a mock-Postgres layer for the thin SQL wrappers —
their logic already lives in the cores, and they are covered by each migration's own
verification query plus the smoke scripts.

> **There is no CI.** No `.github/`, no `vercel.json` here — Vercel only runs
> `next build`, so a failing test cannot block a deploy. `npm run check` is a
> **manual gate**. Wiring it into a GitHub Action is the obvious next step.

## Contact details are blocked, everywhere a user can type

QuickIn earns on the booking, so a host and a guest agreeing to settle off-platform
costs the platform the reservation *and* removes the guest's protection. The counter
is `src/lib/local/contentguard.ts`: one module, enforced server-side on every path
that stores free text.

**What it blocks** — phone numbers, email addresses, social/messaging handles, and
links to other sites. It never lifts: there is no "after the booking is confirmed"
exemption, so check-in details belong in the stay guide, not in chat.

**Where it runs**

| Surface | Enforced in |
| --- | --- |
| Booking chat (`POST /api/local/bookings/:id/messages`) | `createMessage` (db.ts) |
| Pre-booking chat (`POST /api/local/chat`) | `postChatMessage` (db.ts) |
| Reviews (`POST /api/local/reviews`) | `createReview` (reviews.ts) |
| Listing title + description (`POST/PATCH /api/local/listings`) | `createListing`, `updateListingDetails` (db.ts) |
| Profile name + bio (`PATCH /api/local/profile`) | `updateProfile` (auth.ts) |

`users.phone` is deliberately **exempt** — it is the user's own number and is only
ever returned to themselves, never on a listing or a booking.

**How it resists evasion.** Every detector runs after one shared `fold()` pass:
NFKD (which flattens fullwidth `０１０`, enclosed `⓪①`, and presentation forms),
combining marks dropped (Arabic harakat, the keycap on `0️⃣`), invisible characters
dropped (zero-width space, soft hyphen, RTL marks), Cyrillic/Greek lookalikes mapped
to Latin, and Arabic-Indic digits converted. On top of that the phone detector
handles spelled-out numbers in English *and* Arabic, "double five", leet (`0l0`),
and — when the sender has stated intent ("my number is…") — an all-letter number
like `OIO IZ34S67`. Addresses survive `at`/`dot` spelling and bracketing; links are
matched against an explicit TLD list, so "arrive at 5 p.m." is not a domain.

**Split across messages.** `combinesIntoContact` stitches the sender's last 16
messages in the thread, so `010` / `1234567` / `8` is caught, as is `kareem@gmail`
followed by `.com`. Ordinary chat never accumulates: a message only counts as a
fragment if it is nearly all digits, and the sentence path additionally requires
contact intent in the window.

**Allowed through.** QuickIn's own links and a Google/OpenStreetMap map pin — the
guard is about leaving the platform, not about links as such. Extend `ALLOWED_HOSTS`
if that list needs to grow.

**Errors.** `assertNoContactInfo` throws a `ContactBlockedError`; routes detect it
with `isContactBlockedError` and answer **400** with `err.message` verbatim, which is
the sentence the user sees. The iOS and Android clients already surface that text
inline and keep the typed draft.

**Two copies, one policy.** The web project enforces the same module against the same
Neon rows, so `contentguard.ts` is duplicated byte-for-byte and guarded by
`scripts/check-contentguard-parity.mjs` (part of `npm run check`). If the copies
drifted, the weaker one would become the way around the policy for everyone. Edit one,
copy it over the other verbatim, and add cases to `test/unit/contentguard.test.mjs` —
the false-positive half of that file matters as much as the block half.

## Every blocked attempt is recorded

The guard refusing a message left no trace, so someone could try forty times and
nobody would know — and a novel obfuscation that got through was invisible by
definition. `src/lib/local/moderation.ts` is what remembers.

**One row per blocked attempt** in `policy_violations`: who, which category, which
surface, **the full text they typed**, and whether it was only caught by stitching
their recent messages together (`split` — drip-feeding a number over four messages is
not something anyone does by accident). Every guarded write path goes through
`guardContent` / `guardSplitContent` rather than a bare `assertNoContactInfo`, so no
surface can block something silently.

Storing the text is deliberate: a count alone can't tell a determined evader from
someone whose booking reference tripped the guard, and that difference is the whole
decision a moderator makes. It sits behind the `moderation` staff module and reading
it writes a `moderation_viewed` row to `staff_audit_log`.

**Recording is best-effort; blocking is not.** If the insert fails — the migration
hasn't run, the table is briefly unavailable — the user is still refused. A logging
fault must never become a way past the guard. Same reasoning inverted for the gate
below: if `policy_warnings` can't be read, chat keeps working.

**The warning gate.** A moderator can issue a warning, and until the user
acknowledges it every chat send answers **409** with
`{ error, policyWarning: { id, message } }`. Enforced server-side precisely so an app
build that predates the acknowledge dialog cannot ignore it — and `error` repeats the
warning text so such a build still *shows* it rather than a dead end.

|  |  |
| --- | --- |
| `GET /api/local/policy-warning` | `{ warning: { id, message } \| null }` |
| `POST /api/local/policy-warning` | `{ id }` → acknowledged; chat reopens |

Nothing else notifies the user — no email, no push, by design — so the dialog is the
delivery as well as the gate. The clients keep the typed draft, so acknowledging
reopens the composer with the message still in it.

**The console is in the web project** (`/ops` → Moderation, `moderation` module). This
project has no console to serve; what lives here is the recording and the gate, which
must exist on both because the mobile apps only ever talk to this one.

## Guest disputes

A guest raising an issue about a stay — before, during or after — routed to /ops
for investigation. `src/lib/local/disputes.ts` owns filing and reading-your-own;
the console lives in the web project.

**Three separate things, deliberately.** This is none of the two that already
existed, and conflating them would have broken both:

| | What it is | Where |
| --- | --- | --- |
| `payment_proofs.status='disputed'` | "The host rejected my proof and I did pay" — one payment proof's lifecycle | /ops → Payments |
| `reports` | Abuse about a listing, user or review. No booking target, no attachments, three states | /ops → Reports |
| `disputes` | The stay itself: not as described, couldn't get in, host never replied | /ops → Guest disputes |

**Not `/bookings/:id/dispute`** — that path is the payment dispute. Two features
on one path would be a trap for whoever reads it next.

|  |  |
| --- | --- |
| `GET /api/local/disputes` | `{ disputes, categories }` — the guest's own, plus the category list so no client hardcodes it |
| `GET /api/local/disputes?id=…` | `{ dispute, events }` — one, with its full history |
| `GET /api/local/disputes?eligible=1` | `{ eligible[], existing{} }` — which bookings can be disputed, and which already are |
| `POST /api/local/disputes` | `{ bookingId, category, description, photos? }` → 201 |

**Eligible bookings are `confirmed` or `completed`.** Confirmed covers before and
during the stay, completed covers after. `pending` is out (nothing agreed yet —
that's a question for the host, in chat) and so are `cancelled`/`rejected` (no
stay happened; a refund goes through the refund path). The rule is
`canDisputeBooking` in disputes-core, and the clients ask the server rather than
carrying a second copy of it.

**All history is stored** in `dispute_events`: one row when it is filed, one for
every status change, each with the actor and an optional note. Nothing is
overwritten, so "who moved this to Resolved, when, and why" always has an answer.
`closed` is terminal — a resolved dispute can be reopened, a closed one cannot,
which is what makes the queue trustworthy.

**Photos** are base64 data-URLs inline in Postgres, the same convention as
`payment_proofs.image_data`, capped at 6 × ~3.5MB. Every client downscales before
upload; an unmodified phone photo is several MB of base64 and dies against the
request-body limit with no usable error.

**Deliberately NOT content-guarded.** Every other free-text surface runs through
contentguard, but a dispute is addressed to QuickIn staff rather than to the other
party, and it routinely needs to quote contact details as *evidence* ("the host
told me to pay him directly on 010…"). Guarding it would suppress exactly what an
investigator needs.

**The host is not shown the dispute.** It goes to QuickIn, and the copy on every
client says so.

## Admin actions are audited

Every staff-gated mutation in this repo now writes a `staff_audit_log` row — it
previously wrote **none at all**, so an action taken through this API was
unattributable. That includes `admin/notify` (a push + email blast to every user) and
`admin/settings/instapay` (the account guests are told to pay).

`admin/host-applications` was gated on `users.role === 'admin'` — the pre-RBAC check,
which bypassed the staff module system entirely. It now uses
`requireStaff(req, 'applications')` like every other admin route.

Sign-ins are recorded to `user_logins` from every token-minting path here (login,
verify-otp, social, google, apple, reset-password) so the web `/ops` activity feed sees
mobile sign-ins too. Best-effort: a logging failure never blocks a sign-in.

## Who confirms a payment

**QuickIn, not the host.** Guests transfer to QuickIn's Instapay account and upload a
screenshot; an admin accepts or rejects it in the web project's `/ops/payments`. Hosts
still accept or decline the *reservation* — they no longer review transfers, and
`POST /api/local/host/bookings/:id/review` is gone from both repos.

`submitPaymentProof` therefore notifies the **guest** ("we got your screenshot") and
tells the host money arrived without asking them to act. It previously notified only
the host, with "Payment to review" and a link to `/host` — a request they can no longer
fulfil.

The flow, unchanged in the schema: `payment_proofs.status = 'submitted'` +
`bookings.payment_status = 'submitted'` is the pending-confirmation state that both
mobile apps already gate on (`payment_status == "submitted"`), so no app change was
needed.

## Account verification — the verified badge

`users.verification_status` (`unverified | pending | verified | rejected`) is written
by `/ops` in the web project and only **read** here — by `getUserBadges`
(`trust.ts`) and by `host_verified` in `LISTING_COLS`, which ships on every listing
payload the apps receive.

Until this landed, nothing wrote that column: `/ops` updated only
`id_verifications.status`, so **every iOS and Android verified badge was permanently
false** and this repo's own verification queue (which reads
`users WHERE verification_status = 'pending'`) was permanently empty. The apps needed
no change — the columns they already read simply started being populated.

`GET /api/local/admin/listings` no longer returns the inline `ownership_doc`; it
returns `has_ownership_doc` instead. The document itself is served by the web
project's audited `/api/local/admin/documents/:kind/:id`, behind the `documents`
module. No mobile client ever read that field (iOS only writes it, on listing
creation).

## Account status — blocked and removed accounts

`users.account_status` (`'active' | 'blocked' | 'removed'`) is written by `/ops` in the
web project and only **read** here. Two things to know when touching auth:

1. **Enforcement is per-request, not per-login.** Tokens are stateless 30-day HMACs
   with no session table and no revocation, so `getUserFromRequest` re-reads the
   status on every call and returns `null` for a non-active account — the caller's
   normal 401 path. That single chokepoint covers every authenticated route. The
   hardcoded `sub === 'admin'` token is checked *above* it and is never lockable.
2. **Routes that mint a token run before there is a session** and each need their own
   `blockedAccountResponse` call: `login`, `verify-otp`, `resend-otp`, `signup`,
   `forgot-password`, `social`, `google`, `apple`. The social ones must check
   **before** `upsertSocialUser`, which writes the row and marks the email verified —
   otherwise a removed user reactivates themselves by tapping "Sign in with Google".

The rejection is **403 `{ error, accountStatus }` with no `needsVerification`**. Keep
that shape: the apps branch on `403 && needsVerification === true` to reach the OTP
screen, so adding the key would send a suspended user somewhere they can succeed and
still be refused. `adminBroadcast` also skips non-active accounts, so a blocked user
receives no push or email.

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
| `migrate-host-verification.mjs` | `id_verifications.doc_type`, `host_applications.verification_id` (links an application to the ID filed with it), `listings.unpublished_by_verification`, and the host verification-status index. Also **reports** how many approved hosts are unverified and how many live listings they hold — read that before deploying, since the gate is a hard cutover |
| `migrate-commission.mjs` | Makes the platform commission safe on any database: creates `app_settings` if absent, seeds `platform_commission_rate`, adds `bookings.commission_rate` — and backfills it on **every** booking, not just paid ones (`migrate-analytics.mjs` only did the paid ones, which was fine when the column was a reporting field and is not now that guest prices derive from it) |
| `migrate-activity.mjs` | `user_logins` (the one activity event nothing recorded) plus timestamp indexes on `users`/`listings`/`payment_proofs` and a partial index on open reports — the derived activity feed and alert centre in `/ops` |
| `migrate-documents-audit.mjs` | The `staff_audit_log (target_type, target_id)` index, a partial index on `users.verification_status`, the `documents` module grant for existing `verifications`/`listings` moderators, and the backfill of `users.verification_status` from `id_verifications` — the source of truth behind the verified badge |
| `migrate-account-status.mjs` | `users.account_status`/`status_reason`/`status_changed_at`/`status_changed_by`, `listings.unpublished_by_admin`, and the user search indexes — the block / remove lifecycle behind `/ops` → Users |
| `migrate-policy-violations.mjs` | `policy_violations` (every blocked contact-sharing attempt, with the text) and `policy_warnings` (a warning the user must acknowledge before chatting again) — the record behind `/ops` → Moderation. Purely additive, so it is safe to apply well ahead of the deploy |
| `migrate-disputes.mjs` | `disputes` (a guest's issue with a stay: category, description, photos, four-state status, resolution) and `dispute_events` (the filing plus every status change, with actor and note) — behind `/ops` → Guest disputes. Additive |

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
