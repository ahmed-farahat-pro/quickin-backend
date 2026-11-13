-- Run on Neon BEFORE pushing backend e35dc7c (2026-11-13).
-- Idempotent: safe to run more than once.
--
-- host_applications.terms_*: written by POST /api/local/host/apply AND by a host
-- signup (POST /api/auth/signup with role=host, POST /api/local/account/identity).
-- Without them every host application and host signup returns 500.
ALTER TABLE host_applications ADD COLUMN IF NOT EXISTS terms_version text;
ALTER TABLE host_applications ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

-- Verify: should list both columns.
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'host_applications'
   AND column_name IN ('terms_version', 'terms_accepted_at');
