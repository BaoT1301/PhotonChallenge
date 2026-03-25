import { getDB } from './db.js'
import { getEmbedding } from './embeddings.js'

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export interface SearchResult {
  id: number
  raw_text: string
  extracted_facts: string | null
  tags: string | null
  sentiment: number
  created_at: string
  score: number
}

export async function searchMemories(
  query: string,
  topK = 5,
  minScore = 0.3
): Promise<SearchResult[]> {
  const queryEmb = await getEmbedding(query)
  const db = getDB()

  const rows = db
    .prepare(
      `SELECT id, raw_text, extracted_facts, tags, sentiment, embedding, created_at
       FROM memories ORDER BY created_at DESC LIMIT 500`
    )
    .all() as Array<{
    id: number
    raw_text: string
    extracted_facts: string | null
    tags: string | null
    sentiment: number
    embedding: Buffer | null
    created_at: string
  }>

  return rows
    .filter((r) => r.embedding !== null)
    .map((row) => {
      const buf = Buffer.from(row.embedding!)
      const stored = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
      return {
        id: row.id,
        raw_text: row.raw_text,
        extracted_facts: row.extracted_facts,
        tags: row.tags,
        sentiment: row.sentiment,
        created_at: row.created_at,
        score: cosineSimilarity(queryEmb, stored),
      }
    })
    .filter((r) => r.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

/** Get memories from the last N days for reflection */
export function getRecentMemories(days: number, sender?: string): Array<{
  raw_text: string
  extracted_facts: string | null
  tags: string | null
  sentiment: number
  created_at: string
}> {
  const db = getDB()
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  if (sender) {
    return db
      .prepare(
        `SELECT raw_text, extracted_facts, tags, sentiment, created_at
         FROM memories WHERE created_at >= ? AND sender = ? ORDER BY created_at ASC`
      )
      .all(since, sender) as Array<{
      raw_text: string
      extracted_facts: string | null
      tags: string | null
      sentiment: number
      created_at: string
    }>
  }

  return db
    .prepare(
      `SELECT raw_text, extracted_facts, tags, sentiment, created_at
       FROM memories WHERE created_at >= ? ORDER BY created_at ASC`
    )
    .all(since) as Array<{
    raw_text: string
    extracted_facts: string | null
    tags: string | null
    sentiment: number
    created_at: string
  }>
}

/** Average sentiment over recent days — for mood trends */
export function getMoodTrend(sender: string, days = 7): { avg: number; count: number } {
  const db = getDB()
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const row = db
    .prepare(
      `SELECT AVG(sentiment) as avg, COUNT(*) as count
       FROM memories WHERE sender = ? AND created_at >= ?`
    )
    .get(sender, since) as { avg: number | null; count: number }
  return { avg: row.avg ?? 0, count: row.count }
}
