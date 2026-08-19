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
| GET  | `/api/local/listings` | All published listings. Filters: `?location=&guests=&checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD`. `?sort=` is `recommended` (default) \| `price_asc` \| `price_desc` \| `newest`; **`recommended` ranks by rating + completed bookings** — see Search ranking below |
| GET  | `/api/local/listings/[id]` | One listing by UUID (404 if missing) |
| POST | `/api/local/listings` | Create a listing (approved + identity-verified host). The response is the listing plus **`pin_warning`** — `null`, or `{code, scope, message}` when the map pin falls outside the `country` / `region` the host chose. It is a **warning**: the listing is created either way. A lat/lng outside ±90/±180 is a different matter and answers **400** |
| PATCH | `/api/local/listings/[id]` | The host edits their listing. Carries the same **`pin_warning`** field, for the same reason — a pin can be dragged into the wrong country from the editor too |
| GET  | `/api/local/profile/id-change` | The signed-in user's ID number and the state of any request to change it → `{ current, request, can_request }` |
| POST | `/api/local/profile/id-change` | File a change request: `{ requested_value, doc_type, front, back?, reason? }`. **`front` is required** — without a document the reviewer has nothing to check the number against. Resubmitting replaces a request still awaiting review |
| DELETE | `/api/local/profile/id-change` | Withdraw a request still awaiting review (a decided one stays, as the record of the decision) |
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
| POST | `/api/local/host/apply` | Submit (or re-submit after a rejection) a host application — `{full_name, national_id, phone, address, host_type, company?, notes?}`. Never grants hosting; only an admin approval does. `400 {error, fields}` with a message per offending input — the **phone must be a phone number** and the **name must be a name**, not merely non-empty, and both are stored normalized (see below); a refused name also carries `nameProblem`. `409` if the user is already a host or has one under review |
| GET  | `/api/local/host/listing-gate` | May this host add a listing — `{allowed, code, message, reason}`. Same `code` the create route returns on 403, so the apps can refuse up front. `reason` only on a rejection |
| GET  | `/api/local/host/commission` | The platform commission — `{rate, percent}` — so the add/edit-listing screens can show a host what guests will pay. Auth required (a guest holding the rate could divide out the host's raw price) |
| GET  | `/api/local/host/payout-method` | Where QuickIn sends this host's earnings — `{payout_method, payout_ready, is_host}`. `payout_method` is `null` until they add one. Host-only; a guest gets `403 {code:'not_host'}` |
| PUT  | `/api/local/host/payout-method` | Add or replace it — `{method, account_name, …}` where `method` is `bank_account` \| `instapay` \| `wallet`. `400` with the reason on invalid input (the IBAN checksum included) |
| DELETE | `/api/local/host/payout-method` | Remove it — `{removed, payout_method:null, payout_ready:false}`. Idempotent |
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

The same module exports `needsIdentityDocuments(status)` — whether someone with that
verification status still has to upload documents (`verified` and `pending` do not;
`rejected` and "no submission" do). Nothing in **this** project reads it: the mobile apply
endpoint has never collected ID, and mobile users verify through
`POST /api/local/verification`. It lives here because the file is byte-identical across
both projects, and it is the rule the **web** application form and the web
`submitHostApplication` both run so that a guest who already verified from their profile is
not asked to photograph the same ID again to become a host.

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

**The phone number has to be a phone number.** Presence was the only test, so `asdf`
was filed for review as the number our team would call. `src/lib/local/phone-core.ts`
now decides, and it is **byte-identical to the web's copy**
(`scripts/check-phone-core-parity.mjs`) — both repos write the same
`host_applications.phone`, so a rule that held on one surface and not the other would
let the apps file what the web refuses. It normalizes as well as validates, for the
same reason `payout-method-core.ts` does: an Egyptian mobile sent as `+20 10…`,
`0020 10…` or `010…` is stored once as `01XXXXXXXXX`, so one host is one row in `/ops`
and not three. A mobile is 01 + 9 digits **exactly** (a number typed a digit short is
caught here, not by the person dialling it); landlines keep their local form and
anything foreign keeps `+<digits>` E.164, because a host abroad still has to be
reachable. Arabic-Indic and Persian digits fold to ASCII — the apps run in Arabic.

`national_id` is deliberately **not** given the same treatment: a foreign applicant's
passport number contains letters, so "digits only" would refuse a valid document.

**A name has to be a name.** `POST /api/auth/signup` asked only that `full_name` be
non-empty, so `12345` created an account whose display name is `12345` — what a host
reads next to a booking request and what an operator matches against an ID document.
`src/lib/local/name-policy.ts` decides now, and it is **byte-identical to the web's
copy** (`scripts/check-name-policy-parity.mjs`), because both repos create accounts in
the same `users` table. A name must contain **letters** (`\p{L}`, so Arabic counts),
at least two of them, and at most 60 characters. Deliberately *not* "no digits":
Franco-Arabic writes real names with numerals (`Ma7moud`, `3omar`), and refusing those
would turn away exactly the guests this app serves. A 400 carries the plain sentence in
`error` **and** the code in `nameProblem` (`required` · `letters` · `tooShort` ·
`tooLong`), the same shape `emailProblem` and `passwordProblem` use, so a client can
localize the reason without re-deciding it — iOS does, in `Sources/NameRules.swift`.

A request that sends **no** name at all is still accepted, because social sign-in has
none: the name falls back to the local part of the address, and to `Guest` when that
isn't a name either — `0100@gmail.com` would otherwise seed the very thing the rule
refuses.

**`POST /api/local/host/apply` applies the same policy**, and this is where it bites
hardest: the application's `full_name` is the name an operator reads *against the ID
photos* when approving a host, so `12345` was not merely ugly, it was unreviewable. The
name arrives in `fields.full_name` like the other per-field messages, with the code in
`nameProblem` beside it. Both clients check the same rule before submitting — iOS
through `NameRules` (the host form and sign-up share it), Android in
`HostApplyScreen.kt`, which shows the reason under the field and keeps Submit disabled
until the name has letters.

**`PATCH /api/local/profile` applies it too**, and until now it did not — which made
every gate above a front door with an open window beside it. Signup refused `12345`,
then Edit profile in both apps took it without a word, because this route passed
`full_name` straight to `updateProfile`. Anyone could sign up as `Layla` and be `0100`
a minute later. The name is now normalized and checked here before anything is written,
and a refusal answers 400 with `error`, `field: 'full_name'` and the `nameProblem` code,
the same shape `/host/apply` uses. A request that omits `full_name` is untouched
(`COALESCE` leaves the column alone) — it is only a name actually submitted that is
judged, so an avatar-only save still works (the check is inline in the route, like
the sibling `users/[id]` route on the web — `name-policy.ts` stays import-free so
`node --test` can load it). One consequence worth knowing: sending
`full_name: ""` used to blank the column silently and is now a `required` 400.
`PATCH /api/local/users/[id]` on the web has enforced the same rule since it was added.

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

### Search ranking — chalets earn their position

`GET /api/local/listings` defaults to `sort=recommended`, and that order is no longer
"newest first with the editorial favourites on top". It is a performance score in
`[0, 1.05]`, built in `src/lib/local/ranking-core.ts` and evaluated inside Postgres:

```
score = 0.6 × rating component      (guest reviews, shrunk and discounted for doubt)
      + 0.4 × bookings component    (COMPLETED stays, log-damped)
      + 0.05 if is_guest_favorite
```

**Reviews — why the average alone is not enough.** A chalet with one 5★ review must
not outrank one with hundreds of good ones, so the rating half applies two corrections
in order:

1. **Shrinkage.** Every listing is scored as though it also carried `PRIOR_REVIEWS` (5)
   reviews at the platform's own mean, so a lone 5★ lands near that mean instead of at
   the top.
2. **A lower confidence bound.** Shrinkage alone was **not sufficient**, and this was
   caught against real rows rather than reasoned about: on a catalogue averaging 4.71,
   a single 5★ shrinks to 4.76 and *still* beat forty reviews averaging 4.70. So the
   score subtracts `1.28 / √(n + 5)` — one review is worth ±0.52★ of doubt, forty is
   worth ±0.19★. A large body of strong reviews now wins because the platform is *sure*
   of it, which is what the rule was always about.

The boundary is deliberate: a large body of reviews that is genuinely *below* the
catalogue average still ranks lower, because "stronger customer reviews" has to respect
the average too. Volume buys certainty, not immunity.

**Bookings — only stays that happened.** The booking half counts `status = 'completed'`
**or** a `confirmed` booking whose `check_out` has passed — the same test `reviews.ts`
uses to decide a stay is over. `pending`, `rejected` and **`cancelled` never count**, so
a host cannot lift a listing by taking reservations that fall through. It is
`ln(1+n) / ln(1+50)`, capped: proving demand at all is worth far more than extending an
already long record, and past ~50 stays a listing competes on rating alone rather than
crowding out the catalogue.

**Both halves are recency-weighted.** Full weight for a year, then a straight line down
to a 0.25 floor over the following two. A chalet that was busy three years ago and quiet
since drifts down; nothing ever falls to zero, because old success is weaker evidence,
not no evidence.

**Cold start.** A listing with no history scores the platform average minus the doubt of
having no reviews — below a proven listing, above one with genuinely bad reviews, and
never zero. `created_at DESC` breaks ties, so two brand-new listings keep exactly the
order this replaced.

`is_guest_favorite` used to *be* the whole recommended order; it survives as the 0.05
bonus, enough to break a tie but never enough to float a poor listing over a good one.

Nothing is stored or backfilled — the score is derived at read time from `reviews` and
`bookings`, like guest prices are (see the commission above), so a new review or a
completed stay reorders search immediately. The cost is three correlated subqueries per
listing; `scripts/migrate-ranking-indexes.mjs` adds the two indexes that keep them cheap
as the catalogue grows.

`ranking-core.ts` is **byte-identical** to the frontend's copy — both projects rank the
same catalogue, and a drifted weight would put the same two chalets in different orders
on the web and in the apps. `scripts/check-ranking-core-parity.mjs` fails on drift.

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

## The address has to be one mail can reach

`POST /api/auth/signup` used to check one thing about an email: that the request
carried one. Not a shape, not a domain — `if (!email)`. Everything downstream depends
on that address being real, because the account is created *unverified* and the only
way in is the OTP we mail to it. So two things went wrong quietly and constantly.

`layla@email.con` created a real row. `.con` is not a delegated top-level domain, so
nothing can ever be delivered there; the guest sat on the OTP screen waiting for a
code that did not exist, and we kept a dead account. Neither `type="email"` on the
client nor the usual `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` catches it — both check the
*shape* of an address, and the shape is fine. Only the root zone knows.

And every temp-mail service was an unlimited supply of accounts. `x@mailinator.com`
receives the OTP perfectly well, which is the problem: the verification step proves
the mailbox exists, not that anyone owns it.

`src/lib/local/email-core.ts` decides now, and it is **byte-identical to the web's
copy** (`scripts/check-email-core-parity.mjs`), for the reason `name-policy.ts` and
`password-policy.ts` are: both repos open accounts in the same `users` table, and a
rule that holds on only one of the two doors does not hold. It is the largest of the
shared cores — most of it is the IANA root zone, ~1,450 delegated TLDs as a plain
string — and like the others it has no imports, so the same code runs in the routes
and under `node --test`.

Three tiers, cheapest first:

1. **Shape.** RFC 5321 lengths (254 total, 64 local), a dot-atom local part, domain
   labels that start and end alphanumeric, a TLD of the right shape.
2. **The trusted-provider allowlist.** ~180 mailbox providers guests and hosts
   actually use — Gmail, the Microsoft four and their regional suffixes, Yahoo,
   Apple, Proton, Zoho, GMX, Yandex, the Egyptian and Gulf ISPs. A domain on the list
   is accepted immediately and skips the two checks below. **This is a fast path, not
   the policy**: a domain missing from it is *not* refused, which is exactly what
   keeps company addresses (`ahmed@orascom.com`) and universities (`@aucegypt.edu`)
   working. Adding to it is safe; deleting from it is not.
   `privaterelay.appleid.com` is load-bearing — Sign in with Apple hands us that
   domain whenever the user hides their real address.
3. **Root zone, then blocklist.** Everything else must have a really-delegated TLD
   and must not be a known disposable domain (or a subdomain of one — a parent-domain
   walk, so `x@sub.mailinator.com` is refused too).

A refusal names the real problem and, when it can, guesses: `gmail.con` comes back
"“.con” isn't a valid domain extension. Did you mean @gmail.com?" Suggestions are
drawn from a short shortlist of popular domains and TLDs, never from the whole root
zone — `con` is one deletion from `cn` (China) just as it is from `com`, and
searching 1,450 entries produces confident nonsense.

A 400 carries the plain sentence in `error` **and** the code in `emailProblem`
(`required` · `format` · `tooLong` · `unknownTld` · `disposable`, plus `tld` and
`suggestion` when there is one), the same shape `nameProblem` and `passwordProblem`
use, so iOS and Android can localize the reason without re-deciding it.

**The recovery routes are deliberately looser.** `POST /api/auth/forgot-password` and
`POST /api/auth/resend-otp` call `isValidEmail`, which enforces shape and the root
zone but *tolerates* a disposable domain. Both only ever mail an account that already
exists, so refusing there would strand anyone who signed up before the blocklist
without stopping a single new account. The temp-mail gate belongs on `/signup`, and
that is where it is. `POST /api/auth/reset-password` adds no check of its own: it
consumes a code this API issued, so the address already cleared forgot-password.

Refreshing the root zone is a two-repo job: run `npm run check:tlds` on the frontend,
paste the new list into its `email-core.ts`, then copy the whole file over this one
and let `scripts/check-email-core-parity.mjs` confirm they match.

## Password policy — one floor, all three doors

Six characters of anything used to be the whole rule, in all three places that write
a `password_hash`: `POST /api/auth/signup`, `POST /api/auth/reset-password` and
`POST /api/local/change-password`. So `123456` opened a real account, and — because
the web and this API sign into the *same* `users` row — an account created strong on
the web could be weakened back to `123456` through the mobile API. A floor only one
door enforces is not a floor.

`src/lib/local/password-policy.ts` decides now, and it is **byte-identical to the
web's copy** (`scripts/check-password-policy-parity.mjs`), for exactly the reason
`name-policy.ts` is. Like it, the module has no imports, so the same code runs in the
routes and under `node --test`.

Five rules, checked in the order a form's checklist shows them: **8 characters**,
**uppercase**, **lowercase**, **digit**, **symbol**. The order is the point — a
refusal names the first box the guest hasn't ticked, not a paragraph of policy. Three
more checks can't be drawn as a box and are decided after: `whitespace` (a password of
only spaces), `email` (signup and reset pass the address, and change-password passes
the signed-in user's — an account's own address is the top of every
credential-stuffing list) and `common`.

`common` strips the decoration people add to get past exactly this kind of rule:
`Password1!` and `P@ssw0rd123` clear all five character rules, both reduce to
`password`, and both are refused. The blocklist is a few dozen bases rather than a
dictionary, and it matches the *whole* reduced password — `Cairo-Nights-42!` is not
`cairo`.

A 400 carries the plain sentence in `error` **and** the code in `passwordProblem`
(`required` · `tooLong` · `whitespace` · `length` · `uppercase` · `lowercase` ·
`digit` · `symbol` · `email` · `common`), the same shape `emailProblem` and
`nameProblem` use, so a client can localize the reason without re-deciding it.

Two things worth knowing. **A password written purely in a script without case
(Arabic, for one) cannot satisfy `uppercase`/`lowercase`** — a real constraint on an
app whose guests are Egyptian, which is why the web draws the checklist up front
rather than failing on submit; the mobile apps have no such checklist yet and will
show the sentence from `error` instead. And **existing weak passwords keep working** —
nothing rehashes or expires them; the rules apply the next time one is set.

## A compound name has to be a name

`POST /api/local/listings` (and the `PATCH`) take the resort a chalet sits in as
**either** `resort_id` — a row picked from the catalog — **or** `resort_name`, the
free text a host types under the apps' *Other — not listed* option. The typed name
was only ever checked for being non-blank, so `@@@@@`, `!!!!!` and `12345` were
accepted and the listing created. Worse than an ugly catalog entry: a name with no
alphanumerics slugs to `''`, and `resolveResortSelection` reads a slug-less name as
*no resort chosen* — the host's answer was thrown away on save, the listing missed
every resort filter, and nothing queued for the /ops catalog.

**`checkResortName` in `src/lib/local/resort-core.ts`** decides now, next to the
normalizer and the slug it protects. `assertResortName` in `db.ts` runs it on both
doors — `createListing` and `updateListingDetails` — and throws `ListingInputError`,
so the routes answer **400** with the reason. `resolveResortSelection` re-checks as a
storage backstop, so a caller that forgets can't dirty the catalog.

The rule: the name must contain **letters** (`\p{L}`, so Arabic counts), at least two
of them. Deliberately **not** "no punctuation" and **not** "Latin only" — `Marassi
(North)`, `Sa7el Chalet`, `90 Avenue` and `هاسيندا باي` are all names a host really
types, and a rule that turns one of those away leaves the resort blank, which is the
failure it was meant to prevent. `letters` is reported before `tooShort`, so `@@@@@`
hears "write it in words" rather than "add another `@`". A resort **picked** from the
catalog and *nothing typed at all* both pass straight through: they are real answers,
not oversights.

A name with letters but **no** slug — anything in a non-Latin script — is now **kept**
as free text rather than dropped. It has no match key, so it can't auto-link to a
catalog row and can't queue (`resort_submissions` is keyed on the slug), but it is
stored, returned to the apps as typed, and visible to an admin in the /ops
unassigned-names sweep.

`resort-core.ts` is byte-identical to the web project's copy — the same rule runs on
the web host forms, which localize the problem code. `scripts/check-resort-core-parity.mjs`
fails if they drift; `test/unit/resort-core.test.mjs` covers the rule in both
directions.

## The map pin has to be where the listing says it is

A listing states its place twice: in words (`location`, `country`, the curated
`region` chip, the resort) and as a **map pin** (`lat`/`lng`) the host drops. Nothing
compared the two. A host could choose Egypt → North Coast → Porto, pin the map in
**Germany**, and the listing saved without a murmur — then every surface that draws a
listing on a map put that Egyptian chalet in Bavaria. `createListing` here wrote
`input.lat ?? null` straight into the column, so it did not even bound the value: a
latitude of `999` was stored, on a path where the `PATCH` (`assertCoord`) had always
refused it.

**`checkListingPin` in `src/lib/local/listing-geo-policy.ts`** answers the question
now, from **bounding boxes** — one per country the host form offers, one per curated
area (North Coast, Ain Sokhna, El Gouna, Cairo). Not a polygon and not a
reverse-geocode: a reverse-geocode is a rate-limited network call on every pin drag,
offline on mobile and fuzzy to compare against free text, while a box is explainable
to the operator who has to act on it. The boxes are padded outward, because a chalet
pinned a few hundred metres offshore is not an error.

It **warns, it does not refuse.** `POST` and `PATCH` answer with `pin_warning`
(`{code, scope, message}` — `outsideCountry` \| `outsideRegion` \| `outOfRange`) and
create/save the listing regardless: a box drawn in a source file must never be the
reason a real property can't be listed. The web host forms render the same verdict
under their map in the host's own language, and **/ops badges a listing whose pin was
ignored** ("Pin outside Egypt") on the card the operator approves from. Nothing about
the mismatch is stored — it is derived from `lat`/`lng`/`country`/`region` at read
time, so there is no column to migrate and no flag that goes stale when a host fixes
their pin.

The one hard refusal: a coordinate outside ±90/±180 is not a pin at all, and
`assertCoord` now runs on **both** doors — `createListing` as well as
`updateListingDetails` — answering **400**.

`listing-geo-policy.ts` is byte-identical to the web project's copy;
`scripts/check-listing-geo-policy-parity.mjs` fails if they drift (`npm run check`
runs it), and `test/unit/listing-geo-policy.test.mjs` is the same suite in both — it
pins the reported bug (Egypt + North Coast + a Berlin pin), every curated area
against every other, Morocco's negative longitudes, and the silence the module keeps
when it cannot honestly judge (no pin, a country or region it has no box for).
`mobile/ios/Sources/ListingGeoPolicy.swift` and
`mobile/android/app/src/main/java/com/quickin/app/ListingGeoPolicy.kt` are the Swift
and Kotlin translations the two apps warn with — same numbers, same boxes, updated by
hand. Nothing guards those two, so the boxes are the contract between all four files.

## A listing title has to be a title

`createListing` asked for a non-empty string, so `12345`, `2024`, `٠١٢٣٤` and
`@@@@@` cleared it and were published as the listing's **name** — the line on the
explore card, the search result, the booking request the host reads, every push that
names the stay. A field that only checks for emptiness is not checking anything, and
the title is the one field a guest sees before anything else.

**`checkListingTitle` in `src/lib/local/listing-title-policy.ts`** decides now, on
both doors: `createListing` and the `title` branch of the edit patch, through one
`assertListingTitle` helper so the two can never disagree. The rule that does the
work is **letters**: a title must contain at least `MIN_TITLE_LETTERS` (3) letters in
*any* script. Not "must be Latin" and not "no punctuation" — `Nile-view flat (2BR)`,
`Sa7el chalet` (Franco-Arabic spells real words with numerals) and
`شقة بإطلالة على النيل` are all real titles, and a rule that turned one of them away
would be the worse failure. What it refuses is a title with **no letters at all**.
Invisible characters (zero-width spaces, bidi marks, the BOM) are stripped and
whitespace runs collapsed before anything looks, so a title made only of them reads
as empty rather than as non-empty. An over-long title (over `MAX_TITLE_LENGTH`, 200
**code points**, so an emoji counts once) is now **refused** on the edit door instead
of being silently truncated by the `.slice(0, 200)` that used to stand there.

The answer is **400** with the sentence the host has to act on — "Please describe
your listing in words — a title can't be only symbols or numbers" — chosen by problem
code (`required` \| `letters` \| `tooShort` \| `tooLong`), with `letters` checked
before `tooShort` so `@@@@@` is told what is actually wrong with it rather than being
sent back to add a sixth `@`.

`listing-title-policy.ts` is byte-identical to the web project's copy;
`scripts/check-listing-title-policy-parity.mjs` fails if they drift (`npm run check`
runs it). That parity is the whole point here: both repos write titles into the
**same** `listings` table — this one for the iOS and Android apps, the web one for
`/host/new`, the host edit form and the dashboard wizard — so a rule living in only
one of them means `12345` is refused on the website and published from the phone,
into the same grid. `test/unit/listing-title-policy.test.mjs` is the same suite in
both: that digit-only, symbol-only and Arabic-Indic-digit titles are refused, that
the Franco-Arabic and Arabic titles above still get in, that invisibles do not pass
for content, and that the code chosen for each refusal is the one the host can act on.

## A listing has to say enough to be a listing

`createListing` required a **title and a price. That was all.** Every other column
went in as whatever arrived, or `null` — so a listing reached the `listings` table
with no description, no address, no curated area, no map pin and not one photo, from
either door onto this database. The result is a listing a guest cannot **read** (no
description), cannot **find** (no region to filter by), cannot **see** (no photos)
and cannot **place** (no pin, so it is missing from the map the whole browse
experience is built on). Both mobile wizards had already reached half of that
conclusion on their own — each required the area and the pin, neither required a
description or a photo — which is the worst number of clients to nearly agree.

**`src/lib/local/listing-completeness-policy.ts`** decides now, on both doors:

| Door | What it does |
| --- | --- |
| `createListing` | Judges the **whole** listing — a description (at least `MIN_DESCRIPTION_LETTERS`, 20), an address, an area, a map pin, a property type and at least `MIN_LISTING_PHOTOS` (1) photo. Throws `ListingInputError`, so the create route answers **400** with the sentence the host has to act on |
| `updateListingDetails` | Judges only the fields the **patch touches** (`checkListingEdit`). Clearing a field is touching it, so a listing cannot be created complete and then emptied out |
| `deleteListingImage` | Refuses to remove the **last** photo. Counted after the delete, inside the transaction, so the `ROLLBACK` puts it back. Without this the photo rule is bypassable one image at a time — which is exactly how the mobile apps remove them |

The floors count **letters**, not characters, for the same reason
`listing-title-policy.ts` counts them: `....................` is twenty characters and
no description at all. `letters` is reported before `tooShort`, so a box of symbols
hears the real problem instead of being told to add a twenty-first one.

The edit door is deliberately narrower than the create door, because a patch is
partial by design: the iOS app re-submits a proof of ownership with
`PATCH { ownership_doc }` and nothing else, and its edit screen never sends `images`
at all. Re-running the create check on the merged row would refuse both, and would
hold a host's price change hostage to a description their listing never had. The
two-column rules are merged before judging, so patching `lat` alone is still judged as
a pin against the stored `lng`, and swapping the region on a listing that names a
resort is still judged as an area.

The **resort is not required**, and a resort **answers the area requirement on its
own** — a standalone villa belongs to no compound, and `resolveResortSelection`
already derives the region from a chosen resort, so demanding the region separately
would refuse a listing that names its compound and then fill the region in a line
later.

This is a completeness rule, not a quality one: whether the description is any *good*
is what the `/ops` review is for, and every new listing still lands there as
`pending`.

`listing-completeness-policy.ts` is byte-identical to the web project's copy;
`scripts/check-listing-completeness-policy-parity.mjs` fails if they drift (`npm run
check` runs it). That parity is the point — both repos write into the **same**
`listings` table, so a rule living in only one of them means a listing with no photos
is refused on the website and created from the phone, into the same explore grid.
`test/unit/listing-completeness-policy.test.mjs` is the same suite in both: that a
title and a price alone are refused, that each required field is caught when it alone
is missing, that the first problem is reported in **form order**, that half a pin is
no pin while `0,0` is a real coordinate, that a non-array `images` value is zero
photos rather than an exemption — and, for the edit door, that clearing any required
field is refused while a field the patch never mentions is left alone.

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
| `FIREBASE_*` | Push notifications are inert |

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
`moderation-core.ts`, `disputes-core.ts`, `ranking-core.ts`, `phone-core.ts`,
`name-policy.ts`, `password-policy.ts`, `email-core.ts`, `listing-geo-policy.ts`,
`listing-title-policy.ts`, `listing-review-note-core.ts` and `account-status-core.ts`
are the working examples.

`name-policy.test.mjs` carries the signup name rule in both directions: that `12345`,
`٠١٢٣٤`, `0100` and `-----` are refused, and — the half that matters more — that
`Ma7moud`, `Bo`, `محمد أحمد`, `李伟` and `O'Brien` still get in, because a name rule
that turns away a paying guest is the worse failure.

`password-policy.test.mjs` is the web's suite verbatim, which is the point: the two
copies of the module are byte-identical, so the tests that hold one honest have to
hold the other. It pins that `123456`, `password` and `qwerty` are refused; which
single rule a password is told about first (the one a checklist shows unticked); that
length counts characters and not UTF-16 units; that Arabic-Indic digits are digits
while a space is not a symbol; the account-email rule; and the blocklist's
decoration-stripping — `P@ssw0rd123` is `password`, `Cairo-Nights-42!` is not `cairo`.

`email-core.test.mjs` is the web's suite verbatim, for the same reason
`password-policy.test.mjs` is. Its headline assertion is the one the module was
written for — `layla@email.con` must be refused, because both checks that used to
guard signup (`type="email"` and a shape regex) pass it. But the larger half of the
suite is the mirror image, and it is the half to keep growing: the ordinary addresses
a hand-written allowlist would have quietly locked out. `.eg`, `.com.eg`, `.co.uk`
and new gTLDs; a host on their company domain; a student on `@aucegypt.edu`; and
`privaterelay.appleid.com`, which our own Sign in with Apple depends on. A domain
rule that turns away a paying guest is the worse failure, and unlike a bounced OTP it
generates no support ticket — they just leave.

`ranking-core.test.mjs` is worth reading as a cautionary one. Its headline assertion —
that one 5★ review cannot outrank two hundred — passed against an implementation that
did not actually hold the property, because the test only ever asked at one platform
average, and that average happened to be favourable. The bug surfaced only when the
score was run against real rows. The suite now sweeps the assertion across the whole
plausible range of platform averages, and pins the boundary where the rule stops
applying. **A test that only asks under the conditions you had in mind is not a test of
the rule.**

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

**Letters used as separators.** `A0101 S416 M3280` was the one obfuscation that got
through (reported against the iOS bio field, and it applied to all four surfaces).
The separator collapse only bridges *punctuation* between digits — a letter is
correctly not punctuation — so each group stayed under the 8-digit threshold and
nothing matched. The phone detector now also reduces the whole field to its digits
and matches a **shape** against that concatenation: `01[0125]` plus eight more
digits, a full Egyptian mobile. Shape and not length is the whole point — testing a
whole-field concatenation for a merely *long* run would read "built 2000, 12 rooms,
34 beds, 567 sqm" as a 14-digit number. The landline form (`0[23]` + eight digits) is
looser, so it stays behind the intent check. The residual cost is real and accepted:
a bio dense enough to put eleven digits back to back in the right order can still
false-positive, which is why `test/unit/contentguard.test.mjs` carries number-heavy
honest bios in its allow half. A non-Egyptian international number interleaved with
letters is still only caught when intent is stated.

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

## How a host gets paid — the payout method

Money flows *in* through Instapay (above) and *out* to whatever destination the host
declared. `host_payout_methods` holds **one row per host** — a single preferred
destination, not a wallet of many — chosen from three:

| `method` | Fields it carries | `account_ref` (the canonical destination) |
| --- | --- | --- |
| `bank_account` | `bank_name` (required), `iban`, `account_number`, `swift_bic`, `branch` | the IBAN, or the account number when there is no IBAN |
| `instapay` | — | the InstaPay address, e.g. `kareem@instapay` |
| `wallet` | `provider` (`vodafone_cash`, `etisalat_cash`, `orange_money`, `we_pay`, `other`) | the wallet number, normalised to `01XXXXXXXXX` |

**All three are stored whole, because all three have to be payable.** That is why a
credit-card option was withdrawn before this shipped: a card number cannot be paid out
without a processor token, and holding one would have put this database in PCI-DSS
scope for nothing. Bank details carry no such restriction — an IBAN exists to be handed
out — so they are kept in full and shown back in full, which is what lets a host confirm
they typed them correctly.

A bank account needs the bank plus **an IBAN or an account number** — either identifies
the account (an IBAN covers any transfer, an account number plus the bank covers a
domestic one), and demanding both would block a host who only knows one of them.
`normalizeIban()` enforces the ISO 7064 mod-97 checksum *and* the country length, since
a transposition can survive one but not the other; `IBAN_LENGTHS` lists the countries
QuickIn's hosts actually bank in, and an unlisted country is accepted on the checksum
alone rather than refused.

Everything else is derived, never stored: `display`, `method_label`, `provider_label`
and `iban_formatted` come from `rowToPayoutMethod()` at read time, so all three clients
render one wording.

The section is **host-only** (`is_host` OR the legacy `role='host'`, the same rule the
listing gate uses) and gates nothing — a host with no payout method can still list and
still take bookings; they simply have nowhere to be paid. `payout_ready` on the GET is
the profile-completeness flag the clients show that with.

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

### What an ownership document may be

`lib/local/ownership-doc-core.ts` decides what lands in `listings.ownership_doc`:
an image data URL, an `application/pdf` data URL whose bytes really start with
`%PDF-` (the mime is uploader-supplied text; the magic number is not), or an
http(s) link — capped at `OWNERSHIP_DOC_MAX_CHARS` (3.5M chars ≈ a 2.5 MB file).
SVG is refused: `/ops` will not render it, so accepting it only ever stored a
document no operator could open.

PDF was added on 2026-08-19 for the website, where a host can pick a file — a
deed or utility bill is *issued* as a PDF, and image-only forced them to
photograph it off a screen. **This repo accepts PDFs but no mobile client sends
one**: iOS and Android both use a photo picker. It is here so the two halves
cannot disagree about a document already on file — a host who uploads a PDF deed
on the web and then edits that listing from the app must not be refused over it.

| Piece | What it does |
| --- | --- |
| `checkOwnershipDoc` | Returns `'missing' \| 'unsupported' \| 'too_large'` or `null`. Returns the problem instead of throwing so this repo can raise `ListingInputError` (which the routes map to 400) while the web raises a plain `Error` — both answering with the same sentence from `ownershipDocProblemMessage` |
| `assertOwnershipDoc` (db.ts) | The edit paths: `setListingOwnershipDoc` and `updateListing`'s `ownership_doc` field. Refuses the write and tells the host why |
| `createListing` | Deliberately does **not** refuse: an unusable document is stored as `null` and the listing still enters the moderation queue, as it always has |

**Kept byte-identical with the quickin-frontend copy** — both write the same Neon
column. `scripts/check-ownership-doc-core-parity.mjs` (wired into `npm run check`)
fails on drift.

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

## A rejected listing has to say why

`setListingApproval` used to spend the rejection reason and then lose it: the note was
interpolated into the host's notification body and nothing stored it. A host who missed
that one notification was left with a red **Rejected** badge and no way to find out what
to fix — the whole difference between rejecting a listing and deleting it.

`POST /api/local/admin/listings` now takes an optional `note` (`review_note` is accepted
too) and `setListingApproval(listingId, approve, note)` stores it on
`listings.review_note`:

| Piece | What it does |
| --- | --- |
| `lib/local/listing-review-note-core.ts` | `normalizeListingReviewNote` — blank, whitespace and non-string all collapse to the same `null`, so the column never fills with `''` rows that read as a reason downstream; an over-long note is truncated at `MAX_LISTING_REVIEW_NOTE_CHARS` rather than refused, because a slip of the finger must not leave a listing stuck in the queue. `listingRejectionMessage` builds the notification body from that same normalized note. **Kept byte-identical with the quickin-frontend copy** — `/ops` rejects through the web app, this API rejects for the mobile clients, and a disagreement would make the same rejection read differently depending on the door |
| `setListingApproval` | Stores the note on reject, **NULLs it on approve** — the note describes a rejection, and a stale one under a live listing reads as a fresh complaint |
| `REQUEUE_SET` | Clears it whenever an edit or a re-uploaded ownership document sends the listing back to `pending`, so a reason on screen always describes the *current* rejection |
| `LISTING_COLS_HOST` | Returns `review_note`, which is how `GET /api/local/host/listings` feeds the iOS and Android host dashboards. Deliberately **not** in `LISTING_COMMON_COLS`: it is staff-authored text about the host and has no business on a guest read |

The audit row records `noted: true|false`, not the text — the log is read by every staff
member and the note already lives on the listing.

The note stays **optional**: someone clearing a queue of obvious spam should not have to
type, and forcing a reason there would only produce `.`. Every client falls back to
generic "needs changes" copy when it is NULL.

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
| `migrate-payout-methods.mjs` | `host_payout_methods` — one row per host (`UNIQUE user_id`) holding the single destination they chose for their earnings (`bank_name`/`iban`/`account_number`/`swift_bic`/`branch` for a bank account). Also **reports** how many approved hosts have not added one. Additive, and the read path degrades to "none set" if it has not run, so it is safe to apply well ahead of the deploy. Re-running it converges a database built by the first version of the script, which had a `credit_card` method with an `expiry` — that version never reached production, so there is nothing to back-fill |

| `migrate-id-change-requests.mjs` | `id_change_requests` — a user's request to change the ID number on their profile, with the document photo backing it, one open request per user (partial unique index). Behind `/ops` → ID verifications, and the only thing that writes `users.id_document` now that `PATCH /api/local/profile` refuses it. Also **reports** how many accounts already carry a self-declared number that nobody ever reviewed. Additive, and the reads degrade to an empty queue if it has not run, so it is safe to apply well ahead of the deploy |
| `migrate-listing-review-note.mjs` | `listings.review_note` — the operator's reason for rejecting a listing, which used to exist only inside a notification body and is now shown to the host on the web dashboard, in the listing editor and on both mobile host dashboards. Nullable, no backfill: NULL means "no reason recorded", the honest answer both for an unexplained rejection (the note is optional) and for every listing rejected before the column existed. Also **reports** how many rejected listings carry no reason. **Unlike most additive columns this one must be applied BEFORE the deploy** — the host projection selects it, so a database without it fails every host read |
| `migrate-ranking-indexes.mjs` | Two indexes for the search ranking — `reviews(listing_id) INCLUDE (rating, created_at)` and `bookings(listing_id, status, check_out)`. **Pure performance, no schema change:** the ranking is correct without it, so the usual order does not apply and it can be run before or after the deploy |

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
