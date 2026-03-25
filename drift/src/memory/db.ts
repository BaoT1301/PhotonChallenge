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

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_text        TEXT    NOT NULL,
      extracted_facts TEXT,
      embedding       BLOB,
      sender          TEXT    NOT NULL,
      tags            TEXT,
      sentiment       REAL DEFAULT 0,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
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

    CREATE TABLE IF NOT EXISTS people (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT    NOT NULL,
      sender          TEXT    NOT NULL,
      mention_count   INTEGER DEFAULT 0,
      first_mentioned DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_mentioned  DATETIME DEFAULT CURRENT_TIMESTAMP,
      avg_sentiment   REAL DEFAULT 0,
      common_topics   TEXT,
      UNIQUE(name, sender)
    );

    CREATE TABLE IF NOT EXISTS memory_people (
      memory_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      person_name TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS habits (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      sender      TEXT    NOT NULL,
      streak      INTEGER DEFAULT 0,
      best_streak INTEGER DEFAULT 0,
      total_count INTEGER DEFAULT 0,
      last_logged DATE,
      started_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(name, sender)
    );

    CREATE TABLE IF NOT EXISTS agent_state (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_memories_created    ON memories(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_tags       ON memories(tags);
    CREATE INDEX IF NOT EXISTS idx_memories_sender     ON memories(sender);
    CREATE INDEX IF NOT EXISTS idx_reminders_fire      ON reminders(fire_at) WHERE fired = 0;
    CREATE INDEX IF NOT EXISTS idx_people_sender       ON people(sender);
    CREATE INDEX IF NOT EXISTS idx_memory_people_name  ON memory_people(person_name);
    CREATE INDEX IF NOT EXISTS idx_habits_sender       ON habits(sender);
  `)

  return db
}

export function getDB(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDB() first')
  return db
}

// ─── Memories ────────────────────────────────────────────────────────────────

export function getMemoryCount(sender: string): number {
  const row = getDB()
    .prepare('SELECT COUNT(*) as cnt FROM memories WHERE sender = ?')
    .get(sender) as { cnt: number }
  return row.cnt
}

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

export function deleteLastMemory(sender: string): boolean {
  const row = getDB()
    .prepare('SELECT id FROM memories WHERE sender = ? ORDER BY created_at DESC LIMIT 1')
    .get(sender) as { id: number } | undefined
  if (!row) return false
  getDB().prepare('DELETE FROM memories WHERE id = ?').run(row.id)
  return true
}

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

/** Get distinct senders who have stored memories */
export function getDistinctSenders(): string[] {
  return (getDB().prepare('SELECT DISTINCT sender FROM memories').all() as Array<{ sender: string }>)
    .map((r) => r.sender)
}

/** Get open-loop memories: future-intent phrases not recently resolved */
export function getOpenLoops(sender: string, days = 7): Array<{ raw_text: string; created_at: string }> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  return getDB()
    .prepare(
      `SELECT raw_text, created_at FROM memories
       WHERE sender = ? AND created_at >= ?
       AND (raw_text LIKE '%going to%' OR raw_text LIKE '%planning to%'
         OR raw_text LIKE '%need to%' OR raw_text LIKE '%want to%'
         OR raw_text LIKE '%will %' OR raw_text LIKE '%should %')
       ORDER BY created_at DESC LIMIT 5`
    )
    .all(sender, since) as Array<{ raw_text: string; created_at: string }>
}

// ─── Reminders ───────────────────────────────────────────────────────────────

export function getDueReminders(): Array<{ id: number; sender: string; content: string }> {
  return getDB()
    .prepare(`SELECT id, sender, content FROM reminders WHERE fired = 0 AND fire_at <= datetime('now')`)
    .all() as Array<{ id: number; sender: string; content: string }>
}

export function markReminderFired(id: number): void {
  getDB().prepare('UPDATE reminders SET fired = 1 WHERE id = ?').run(id)
}

export function saveReminder(sender: string, content: string, fireAt: Date): number {
  const result = getDB()
    .prepare('INSERT INTO reminders (sender, content, fire_at) VALUES (?, ?, ?)')
    .run(sender, content, fireAt.toISOString())
  return result.lastInsertRowid as number
}

// ─── Failed messages ─────────────────────────────────────────────────────────

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

export function incrementFailedRetry(id: number): void {
  getDB().prepare('UPDATE failed_messages SET retry_count = retry_count + 1 WHERE id = ?').run(id)
}

export function deleteFailedMessage(id: number): void {
  getDB().prepare('DELETE FROM failed_messages WHERE id = ?').run(id)
}

// ─── People ──────────────────────────────────────────────────────────────────

export function upsertPerson(
  sender: string,
  name: string,
  sentiment: number,
  topics: string[]
): void {
  const db = getDB()
  const existing = db
    .prepare('SELECT id, mention_count, avg_sentiment, common_topics FROM people WHERE name = ? AND sender = ?')
    .get(name, sender) as { id: number; mention_count: number; avg_sentiment: number; common_topics: string | null } | undefined

  if (existing) {
    const newCount = existing.mention_count + 1
    const newSentiment = (existing.avg_sentiment * existing.mention_count + sentiment) / newCount

    // Merge topics
    const existingTopics: string[] = existing.common_topics ? JSON.parse(existing.common_topics) : []
    const merged = [...new Set([...existingTopics, ...topics])].slice(0, 10)

    db.prepare(
      `UPDATE people SET mention_count = ?, avg_sentiment = ?, common_topics = ?,
       last_mentioned = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(newCount, newSentiment, JSON.stringify(merged), existing.id)
  } else {
    db.prepare(
      `INSERT INTO people (name, sender, mention_count, avg_sentiment, common_topics)
       VALUES (?, ?, 1, ?, ?)`
    ).run(name, sender, sentiment, JSON.stringify(topics))
  }
}

export function linkMemoryToPeople(memoryId: number, names: string[]): void {
  const stmt = getDB().prepare('INSERT OR IGNORE INTO memory_people (memory_id, person_name) VALUES (?, ?)')
  for (const name of names) stmt.run(memoryId, name)
}

export function getPersonProfile(
  sender: string,
  name: string
): { mention_count: number; avg_sentiment: number; common_topics: string | null; first_mentioned: string; last_mentioned: string } | undefined {
  return getDB()
    .prepare(
      'SELECT mention_count, avg_sentiment, common_topics, first_mentioned, last_mentioned FROM people WHERE sender = ? AND name = ? COLLATE NOCASE'
    )
    .get(sender, name) as { mention_count: number; avg_sentiment: number; common_topics: string | null; first_mentioned: string; last_mentioned: string } | undefined
}

export function getMemoriesAboutPerson(
  sender: string,
  name: string,
  limit = 10
): Array<{ raw_text: string; created_at: string; sentiment: number }> {
  return getDB()
    .prepare(
      `SELECT m.raw_text, m.created_at, m.sentiment
       FROM memories m
       JOIN memory_people mp ON mp.memory_id = m.id
       WHERE m.sender = ? AND mp.person_name = ? COLLATE NOCASE
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(sender, name, limit) as Array<{ raw_text: string; created_at: string; sentiment: number }>
}

// ─── Habits ──────────────────────────────────────────────────────────────────

export function updateHabitStreak(sender: string, habitName: string): {
  streak: number
  best_streak: number
  total_count: number
  isNew: boolean
  isMilestone: boolean
} {
  const db = getDB()
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

  const existing = db
    .prepare('SELECT * FROM habits WHERE name = ? AND sender = ?')
    .get(habitName, sender) as {
    id: number; streak: number; best_streak: number; total_count: number; last_logged: string | null
  } | undefined

  if (!existing) {
    db.prepare(
      'INSERT INTO habits (name, sender, streak, best_streak, total_count, last_logged) VALUES (?, ?, 1, 1, 1, ?)'
    ).run(habitName, sender, today)
    return { streak: 1, best_streak: 1, total_count: 1, isNew: true, isMilestone: false }
  }

  // Already logged today — no change
  if (existing.last_logged === today) {
    return { streak: existing.streak, best_streak: existing.best_streak, total_count: existing.total_count, isNew: false, isMilestone: false }
  }

  const newStreak = existing.last_logged === yesterday ? existing.streak + 1 : 1
  const newBest = Math.max(newStreak, existing.best_streak)
  const newTotal = existing.total_count + 1
  const milestones = [3, 7, 14, 21, 30, 50, 100]
  const isMilestone = milestones.includes(newStreak)

  db.prepare(
    'UPDATE habits SET streak = ?, best_streak = ?, total_count = ?, last_logged = ? WHERE id = ?'
  ).run(newStreak, newBest, newTotal, today, existing.id)

  return { streak: newStreak, best_streak: newBest, total_count: newTotal, isNew: false, isMilestone }
}

export function getAllHabits(sender: string): Array<{
  name: string; streak: number; best_streak: number; total_count: number; last_logged: string | null
}> {
  return getDB()
    .prepare('SELECT name, streak, best_streak, total_count, last_logged FROM habits WHERE sender = ? ORDER BY streak DESC')
    .all(sender) as Array<{ name: string; streak: number; best_streak: number; total_count: number; last_logged: string | null }>
}

// ─── Agent state ─────────────────────────────────────────────────────────────

export function getAgentState(key: string): string | null {
  const row = getDB().prepare('SELECT value FROM agent_state WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setAgentState(key: string, value: string): void {
  getDB()
    .prepare('INSERT OR REPLACE INTO agent_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
    .run(key, value)
}
