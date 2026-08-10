// migrate-cross-db.mjs — One-time cross-database migration
//
// Pulls ALL data from SOURCE_DATABASE_URL (the source Neon DB) and merges it
// into DATABASE_URL (the backend's current production DB), preserving the admin
// staff_accounts row(s) in the target.
//
// Usage:
//   SOURCE_DATABASE_URL='<source>' DATABASE_URL='<target>' node scripts/migrate-cross-db.mjs
//
// The script is idempotent-ish: running it twice won't create duplicates
// (ON CONFLICT DO NOTHING on UUID PKs). But the intent is a single run.
import pg from 'pg'

const SOURCE_URL = process.env.SOURCE_DATABASE_URL
const TARGET_URL = process.env.DATABASE_URL

if (!SOURCE_URL) throw new Error('SOURCE_DATABASE_URL is required')
if (!TARGET_URL) throw new Error('DATABASE_URL is required')

const isSourceLocal = SOURCE_URL.includes('127.0.0.1') || SOURCE_URL.includes('localhost')
const isTargetLocal = TARGET_URL.includes('127.0.0.1') || TARGET_URL.includes('localhost')

const srcPool = new pg.Pool({
  connectionString: SOURCE_URL,
  max: 5,
  ssl: isSourceLocal ? false : { rejectUnauthorized: false },
})
const tgtPool = new pg.Pool({
  connectionString: TARGET_URL,
  max: 5,
  ssl: isTargetLocal ? false : { rejectUnauthorized: false },
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

/** Get all user-created table names (skip system / pg_catalog). */
async function getTables(pool) {
  const { rows } = await pool.query(`
    SELECT tablename
      FROM pg_catalog.pg_tables
     WHERE schemaname = 'public'
     ORDER BY tablename
  `)
  return rows.map((r) => r.tablename)
}

/** Get column names for a table, in ordinal order. */
async function getColumns(pool, table) {
  const { rows } = await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position
  `, [table])
  return rows.map((r) => r.column_name)
}

/** Count rows in a table. */
async function countRows(pool, table) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${table}"`)
  return rows[0].n
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('Starting cross-database migration')
  log(`  SOURCE: ${SOURCE_URL.replace(/:[^@]+@/, ':***@')}`)
  log(`  TARGET: ${TARGET_URL.replace(/:[^@]+@/, ':***@')}`)

  // 1. Discover tables on both sides
  const srcTables = await getTables(srcPool)
  const tgtTables = await getTables(tgtPool)
  const tgtTableSet = new Set(tgtTables)
  const srcTableSet = new Set(srcTables)

  log(`  Source tables: ${srcTables.length}`)
  log(`  Target tables: ${tgtTables.length}`)

  // Tables that exist in both (we only copy these)
  const commonTables = srcTables.filter((t) => tgtTableSet.has(t))
  const onlyInSource = srcTables.filter((t) => !tgtTableSet.has(t))
  const onlyInTarget = tgtTables.filter((t) => !srcTableSet.has(t))

  if (onlyInSource.length) {
    log(`  ⚠ Tables only in source (will be skipped): ${onlyInSource.join(', ')}`)
  }
  if (onlyInTarget.length) {
    log(`  Tables only in target (will be untouched): ${onlyInTarget.join(', ')}`)
  }

  // 2. Save admin rows from target (staff_accounts + related)
  log('Saving admin staff_accounts from target...')

  // staff_accounts — save all rows (these are the admin accounts)
  const { rows: savedAdmins } = await tgtPool.query(
    `SELECT * FROM staff_accounts`
  )
  log(`  Saved ${savedAdmins.length} staff_accounts row(s)`)

  // staff_audit_log — save for admin entries
  const { rows: savedAuditLogs } = await tgtPool.query(
    `SELECT * FROM staff_audit_log`
  )
  log(`  Saved ${savedAuditLogs.length} staff_audit_log row(s)`)

  // staff_sessions — save for admin sessions
  let savedSessions = []
  try {
    const r = await tgtPool.query(`SELECT * FROM staff_sessions`)
    savedSessions = r.rows
    log(`  Saved ${savedSessions.length} staff_sessions row(s)`)
  } catch { /* table may not exist */ }

  // staff_permissions — save
  let savedPermissions = []
  try {
    const r = await tgtPool.query(`SELECT * FROM staff_permissions`)
    savedPermissions = r.rows
    log(`  Saved ${savedPermissions.length} staff_permissions row(s)`)
  } catch { /* table may not exist */ }

  // staff_password_resets — save
  let savedResets = []
  try {
    const r = await tgtPool.query(`SELECT * FROM staff_password_resets`)
    savedResets = r.rows
    log(`  Saved ${savedResets.length} staff_password_resets row(s)`)
  } catch { /* table may not exist */ }

  // 3. TRUNCATE all common tables in target (in reverse-dependency order to avoid FK issues)
  log('Truncating target tables...')
  // Order: child tables first, then parent tables
  const truncateOrder = [
    'chat_messages', 'conversations', 'saved_listings', 'wishlists',
    'guest_reviews', 'reviews', 'payment_proofs', 'booking_messages',
    'messages', 'stay_guide_items', 'bookings',
    'listing_blocked_dates', 'listing_images', 'listings',
    'service_requests', 'services',
    'notifications', 'device_tokens',
    'host_applications', 'id_verifications', 'otp_codes',
    'reports', 'referrals', 'promo_codes',
    'app_settings',
    'users',
    'staff_password_resets', 'staff_permissions', 'staff_sessions',
    'staff_audit_log', 'staff_accounts',
  ]

  for (const table of truncateOrder) {
    if (!commonTables.includes(table)) continue
    try {
      await tgtPool.query(`TRUNCATE TABLE "${table}" CASCADE`)
      log(`  Truncated ${table}`)
    } catch (e) {
      log(`  ⚠ Could not truncate ${table}: ${e.message}`)
    }
  }

  // Also truncate any remaining common tables not in the explicit order
  for (const table of commonTables) {
    if (truncateOrder.includes(table)) continue
    try {
      await tgtPool.query(`TRUNCATE TABLE "${table}" CASCADE`)
      log(`  Truncated ${table}`)
    } catch (e) {
      log(`  ⚠ Could not truncate ${table}: ${e.message}`)
    }
  }

  // 5. Copy data from source → target, table by table
  log('Copying data from source to target...')

  // Use a topological-ish order: parent tables first
  const copyOrder = [
    'users',
    'listings',
    'listing_images',
    'listing_blocked_dates',
    'bookings',
    'payment_proofs',
    'stay_guide_items',
    'messages',
    'reviews',
    'guest_reviews',
    'wishlists',
    'saved_listings',
    'conversations',
    'chat_messages',
    'notifications',
    'device_tokens',
    'host_applications',
    'id_verifications',
    'otp_codes',
    'services',
    'service_requests',
    'promo_codes',
    'referrals',
    'reports',
    'app_settings',
    'staff_accounts',
    'staff_sessions',
    'staff_permissions',
    'staff_password_resets',
    'staff_audit_log',
  ]

  // Process in declared order first, then any remaining tables
  const tablesToCopy = [...copyOrder.filter((t) => commonTables.includes(t)),
    ...commonTables.filter((t) => !copyOrder.includes(t))]

  for (const table of tablesToCopy) {
    // Get column intersection (source columns that also exist in target)
    const srcCols = await getColumns(srcPool, table)
    const tgtCols = await getColumns(tgtPool, table)
    const tgtColSet = new Set(tgtCols)
    const sharedCols = srcCols.filter((c) => tgtColSet.has(c))

    if (sharedCols.length === 0) {
      log(`  ${table}: no shared columns, skipping`)
      continue
    }

    const srcCount = await countRows(srcPool, table)
    if (srcCount === 0) {
      log(`  ${table}: 0 rows in source, skipping`)
      continue
    }

    log(`  ${table}: copying ${srcCount} rows (${sharedCols.length} columns)...`)

    const colList = sharedCols.map((c) => `"${c}"`).join(', ')
    const { rows } = await srcPool.query(`SELECT ${colList} FROM "${table}"`)

    let copied = 0
    const BATCH_SIZE = 500
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      await insertBatch(tgtPool, table, sharedCols, batch)
      copied += batch.length
    }

    log(`  ${table}: ✓ ${copied} rows copied`)
  }

  // 6. Restore admin rows
  log('Restoring admin rows...')

  // Restore staff_accounts (skip if they were already copied from source)
  if (savedAdmins.length > 0) {
    for (const row of savedAdmins) {
      const cols = Object.keys(row)
      const colList = cols.map((c) => `"${c}"`).join(', ')
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
      const vals = cols.map((c) => row[c])
      try {
        await tgtPool.query(
          `INSERT INTO staff_accounts (${colList}) VALUES (${placeholders})
           ON CONFLICT (id) DO NOTHING`,
          vals
        )
        log(`  Restored staff_account: ${row.email}`)
      } catch (e) {
        log(`  ⚠ Could not restore staff_account ${row.email}: ${e.message}`)
      }
    }
  }

  // Restore staff_audit_log
  if (savedAuditLogs.length > 0) {
    const cols = Object.keys(savedAuditLogs[0])
    const colList = cols.map((c) => `"${c}"`).join(', ')
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
    for (const row of savedAuditLogs) {
      const vals = cols.map((c) => row[c])
      try {
        await tgtPool.query(
          `INSERT INTO staff_audit_log (${colList}) VALUES (${placeholders})
           ON CONFLICT (id) DO NOTHING`,
          vals
        )
      } catch { /* skip duplicates */ }
    }
    log(`  Restored ${savedAuditLogs.length} staff_audit_log rows`)
  }

  // Restore staff_sessions
  if (savedSessions.length > 0) {
    const cols = Object.keys(savedSessions[0])
    const colList = cols.map((c) => `"${c}"`).join(', ')
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
    for (const row of savedSessions) {
      const vals = cols.map((c) => row[c])
      try {
        await tgtPool.query(
          `INSERT INTO staff_sessions (${colList}) VALUES (${placeholders})
           ON CONFLICT (id) DO NOTHING`,
          vals
        )
      } catch { /* skip */ }
    }
    log(`  Restored ${savedSessions.length} staff_sessions rows`)
  }

  // Restore staff_permissions
  if (savedPermissions.length > 0) {
    const cols = Object.keys(savedPermissions[0])
    const colList = cols.map((c) => `"${c}"`).join(', ')
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
    for (const row of savedPermissions) {
      const vals = cols.map((c) => row[c])
      try {
        await tgtPool.query(
          `INSERT INTO staff_permissions (${colList}) VALUES (${placeholders})
           ON CONFLICT DO NOTHING`,
          vals
        )
      } catch { /* skip */ }
    }
    log(`  Restored ${savedPermissions.length} staff_permissions rows`)
  }

  // Restore staff_password_resets
  if (savedResets.length > 0) {
    const cols = Object.keys(savedResets[0])
    const colList = cols.map((c) => `"${c}"`).join(', ')
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
    for (const row of savedResets) {
      const vals = cols.map((c) => row[c])
      try {
        await tgtPool.query(
          `INSERT INTO staff_password_resets (${colList}) VALUES (${placeholders})
           ON CONFLICT (id) DO NOTHING`,
          vals
        )
      } catch { /* skip */ }
    }
    log(`  Restored ${savedResets.length} staff_password_resets rows`)
  }

  // 7. Reset sequences so new inserts don't collide with existing IDs
  log('Resetting sequences...')
  for (const table of commonTables) {
    try {
      // Reset any serial/identity sequence to max(id) + 1
      const { rows: seqs } = await tgtPool.query(`
        SELECT pg_get_serial_sequence('public."${table}"', c.column_name) AS seq
          FROM information_schema.columns c
         WHERE c.table_schema = 'public' AND c.table_name = $1
           AND (c.column_default LIKE 'nextval%' OR c.identity_generation IS NOT NULL)
      `, [table])
      for (const { seq } of seqs) {
        if (!seq) continue
        await tgtPool.query(`SELECT setval('${seq}', COALESCE((SELECT max(id) FROM "${table}"), 1))`)
      }
    } catch { /* not all tables have sequences */ }
  }

  // 9. Summary
  log('─── Migration complete ───')
  for (const table of commonTables) {
    try {
      const n = await countRows(tgtPool, table)
      log(`  ${table}: ${n} rows`)
    } catch { /* skip */ }
  }

  await srcPool.end()
  await tgtPool.end()
}

/** Insert a batch of rows using a multi-row INSERT with ON CONFLICT DO NOTHING. */
async function insertBatch(pool, table, cols, rows) {
  if (rows.length === 0) return
  const colList = cols.map((c) => `"${c}"`).join(', ')
  // Build multi-row VALUES
  const valueSets = []
  const params = []
  let paramIdx = 1
  for (const row of rows) {
    const placeholders = cols.map((c) => {
      params.push(row[c])
      return `$${paramIdx++}`
    })
    valueSets.push(`(${placeholders.join(', ')})`)
  }
  const sql = `INSERT INTO "${table}" (${colList}) VALUES ${valueSets.join(', ')} ON CONFLICT DO NOTHING`
  await pool.query(sql, params)
}

main().catch(async (e) => {
  console.error('MIGRATION FAILED:', e)
  try { await srcPool.end() } catch {}
  try { await tgtPool.end() } catch {}
  process.exit(1)
})
