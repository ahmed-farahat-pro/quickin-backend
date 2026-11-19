-- /ops → Comments (2026-11-19). Paste into the Neon SQL editor BEFORE deploying the
-- backend commit that adds the To review queue. Idempotent — safe to run twice.
--
-- deleted_by / delete_reason: added to migrate-listing-comments.mjs AFTER that script
-- had already been run on Neon (2026-10-02), so the staff list query — and an author
-- deleting their own comment — fail on a missing column until these exist.
ALTER TABLE listing_comments ADD COLUMN IF NOT EXISTS deleted_by text;
ALTER TABLE listing_comments ADD COLUMN IF NOT EXISTS delete_reason text;

-- The review queue: NULL reviewed_at on a live comment = "To review".
ALTER TABLE listing_comments ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE listing_comments ADD COLUMN IF NOT EXISTS reviewed_by text;
CREATE INDEX IF NOT EXISTS listing_comments_review_idx
  ON listing_comments (created_at DESC) WHERE deleted_at IS NULL AND reviewed_at IS NULL;

-- Check: should list all four columns.
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'listing_comments'
   AND column_name IN ('deleted_by', 'delete_reason', 'reviewed_at', 'reviewed_by');
