import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

let db: Database.Database

export function initDB(): Database.Database {
  const dbPath = path.join(process.cwd(), 'data', 'drift.db')

  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  db = new Database(dbPath)

  // WAL mode: safe concurrent reads during writes, better performance
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_text    TEXT    NOT NULL,
      extracted_facts TEXT,         -- JSON array of strings
      embedding   BLOB,             -- Float32Array as Buffer
      sender      TEXT    NOT NULL,
      tags        TEXT,             -- comma-separated
      sentiment   REAL DEFAULT 0,   -- -1.0 (negative) to 1.0 (positive)
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sender      TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      fire_at     DATETIME NOT NULL,
      fired       INTEGER DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS failed_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_text    TEXT    NOT NULL,
      sender      TEXT    NOT NULL,
      error       TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_memories_created  ON memories(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_tags     ON memories(tags);
    CREATE INDEX IF NOT EXISTS idx_memories_sender   ON memories(sender);
    CREATE INDEX IF NOT EXISTS idx_reminders_fire    ON reminders(fire_at) WHERE fired = 0;
  `)

  return db
}

export function getDB(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDB() first')
  return db
}

/** Returns the count of memories stored for this sender */
export function getMemoryCount(sender: string): number {
  const row = getDB()
    .prepare('SELECT COUNT(*) as cnt FROM memories WHERE sender = ?')
    .get(sender) as { cnt: number }
  return row.cnt
}

/** Returns top tags for a sender with counts */
export function getTopTags(sender: string, limit = 8): Array<{ tag: string; count: number }> {
  const rows = getDB()
    .prepare('SELECT tags FROM memories WHERE sender = ? AND tags IS NOT NULL')
    .all(sender) as Array<{ tags: string }>

  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const tag of row.tags.split(',').map((t) => t.trim()).filter(Boolean)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }))
}

/** Delete the most recent memory for a sender */
export function deleteLastMemory(sender: string): boolean {
  const row = getDB()
    .prepare('SELECT id FROM memories WHERE sender = ? ORDER BY created_at DESC LIMIT 1')
    .get(sender) as { id: number } | undefined
  if (!row) return false
  getDB().prepare('DELETE FROM memories WHERE id = ?').run(row.id)
  return true
}

/** Get all unfired reminders that are due */
export function getDueReminders(): Array<{ id: number; sender: string; content: string }> {
  return getDB()
    .prepare(`SELECT id, sender, content FROM reminders WHERE fired = 0 AND fire_at <= datetime('now')`)
    .all() as Array<{ id: number; sender: string; content: string }>
}

/** Mark a reminder as fired */
export function markReminderFired(id: number): void {
  getDB().prepare('UPDATE reminders SET fired = 1 WHERE id = ?').run(id)
}

/** Save a reminder to DB */
export function saveReminder(sender: string, content: string, fireAt: Date): number {
  const result = getDB()
    .prepare('INSERT INTO reminders (sender, content, fire_at) VALUES (?, ?, ?)')
    .run(sender, content, fireAt.toISOString())
  return result.lastInsertRowid as number
}

/** Get failed messages that haven't exceeded retry limit */
export function getPendingFailedMessages(maxRetries = 3): Array<{
  id: number
  raw_text: string
  sender: string
  retry_count: number
}> {
  return getDB()
    .prepare(
      'SELECT id, raw_text, sender, retry_count FROM failed_messages WHERE retry_count < ? ORDER BY created_at ASC'
    )
    .all(maxRetries) as Array<{ id: number; raw_text: string; sender: string; retry_count: number }>
}

/** Increment retry count on a failed message */
export function incrementFailedRetry(id: number): void {
  getDB().prepare('UPDATE failed_messages SET retry_count = retry_count + 1 WHERE id = ?').run(id)
}

/** Delete a failed message after successful retry */
export function deleteFailedMessage(id: number): void {
  getDB().prepare('DELETE FROM failed_messages WHERE id = ?').run(id)
}

/** Get all memories for a sender as text (for export) */
export function getAllMemoriesForExport(sender: string): Array<{
  raw_text: string
  extracted_facts: string | null
  tags: string | null
  sentiment: number
  created_at: string
}> {
  return getDB()
    .prepare(
      'SELECT raw_text, extracted_facts, tags, sentiment, created_at FROM memories WHERE sender = ? ORDER BY created_at ASC'
    )
    .all(sender) as Array<{
    raw_text: string
    extracted_facts: string | null
    tags: string | null
    sentiment: number
    created_at: string
  }>
}
