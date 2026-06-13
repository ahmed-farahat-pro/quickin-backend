import { pool } from './pool'

// In-app notifications — a per-user feed written on key events. Reads power the
// web bell + a mobile feed; the same rows can later trigger FCM push.

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s)

export interface Notification {
  id: string
  user_id: string
  type: string
  title: string
  body: string | null
  link: string | null
  read: boolean
  created_at: string
}

/** Best-effort insert — never throws into the calling mutation. */
export async function createNotification(
  userId: string | null | undefined,
  n: { type?: string; title: string; body?: string | null; link?: string | null }
): Promise<void> {
  if (!userId || !isUuid(userId)) return
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,$2,$3,$4,$5)`,
      [userId, n.type ?? 'info', n.title, n.body ?? null, n.link ?? null]
    )
  } catch (e) {
    console.error('createNotification failed (ignored):', e)
  }
}

export async function getUserNotifications(userId: string): Promise<Notification[]> {
  if (!isUuid(userId)) return []
  const { rows } = await pool.query(
    `SELECT id, user_id, type, title, body, link, read, created_at
       FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId]
  )
  return rows as Notification[]
}

export async function getUnreadCount(userId: string): Promise<number> {
  if (!isUuid(userId)) return 0
  const { rows } = await pool.query(
    `SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND read = false`,
    [userId]
  )
  return rows[0]?.c ?? 0
}

export async function markRead(id: string, userId: string): Promise<void> {
  if (!isUuid(id) || !isUuid(userId)) return
  await pool.query(`UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2`, [id, userId])
}

export async function markAllRead(userId: string): Promise<void> {
  if (!isUuid(userId)) return
  await pool.query(`UPDATE notifications SET read = true WHERE user_id = $1 AND read = false`, [userId])
}

/** Register a device token for future FCM push (stored idempotently). */
export async function registerDeviceToken(userId: string, token: string, platform?: string): Promise<void> {
  if (!isUuid(userId) || !token) return
  await pool.query(
    `INSERT INTO device_tokens (user_id, token, platform) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, token) DO NOTHING`,
    [userId, token, platform ?? null]
  )
}
