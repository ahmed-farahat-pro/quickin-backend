# CLAUDE.md — quickin-backend

Guidance for Claude Code / AI agents working in this repo.

## What this is

`quickin-backend` is **one of two Vercel projects** behind QuickIn (a boutique vacation-rental app). It is a **Next.js 16** API that:

- Serves the **API the mobile apps call** (iOS `Config.apiBaseURL` and Android `BuildConfig.API_BASE_URL` both point at `https://quickin-backend.vercel.app`).
- Owns the **working SMTP** (nodemailer → `mail.privateemail.com`) and exposes an internal **OTP mail relay** `POST /api/mail/send-otp` (shared secret `MAIL_RELAY_SECRET`) that the **web** project (`quickin-frontend`) calls to send its OTP emails.
- Generates Apple Wallet passes (`/api/wallet/pass/*`).

The **web** UI lives in a separate repo (`quickin-master` → deployed as `quickin-frontend`). **Both Vercel projects share ONE Neon Postgres database**, so users/listings/bookings created here are visible to the web `/ops` admin and vice-versa. The full cross-project picture is in `quickin-master/docs/ARCHITECTURE.md`.

## Layout

- `src/app/api/auth/*` — signup, login, verify-otp, resend-otp, forgot/reset-password, google, apple, social, me, logout, **smtp-status** (a non-secret SMTP probe).
- `src/app/api/mail/send-otp` — the relay the web calls (secret-gated).
- `src/app/api/local/*` — app data (listings, bookings, host/*, admin/*, services, notifications, …).
- `src/lib/local/db.ts` — SQL (node-postgres). `src/lib/local/auth.ts` — users/OTP/token. `src/lib/local/mailer.ts` — nodemailer + templates (`sendOtpEmail`, `sendNotificationEmail`, `smtpConfigured`, `smtpDiagnostics`).

## Auth model — note the divergence from web

This backend still uses the **older dual `(email, role)` account model**: `getUserRowByEmailRole(email, role)`, and the OTP is stored **on the user row** via `setUserOtp` (not a separate `otp_codes` table like the web). It **does** have `users.email_verified` and gates login the same way as the web: an unverified login returns **HTTP 403 `{needsVerification:true, email}`** and re-sends the code, which the mobile apps route to their OTP screen. When changing auth, keep that 403/`needsVerification` contract intact (mobile depends on it).

## Env (Vercel, Production)

`SMTP_HOST/PORT/USER/PASS/FROM` (mail.privateemail.com:465), `MAIL_RELAY_SECRET` (must match quickin-frontend), `DATABASE_URL` (shared Neon), `ADMIN_USERNAME/PASSWORD`, `OPENAI_API_KEY`, Apple/Google client IDs, `PASS_*` (wallet). Env values are encrypted — set via `vercel env add`, never paste `vercel env pull` ciphertext back as a value.

## Deploy

`git push origin main` → Vercel auto-deploys. The Vercel CLI also works but the free tier caps uploads (~5000 files/day → "Upload aborted"); prefer git push. Verify SMTP reached the runtime via `GET /api/auth/smtp-status`.
