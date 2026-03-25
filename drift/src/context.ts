import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

interface Turn {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

const SNAPSHOT_PATH = path.join(process.cwd(), 'data', 'context-snapshot.json')
const WINDOW_MS = config.contextWindowMinutes * 60 * 1000

export class ConversationContext {
  private turns: Turn[] = []

  add(role: 'user' | 'assistant', content: string): void {
    this.turns.push({ role, content, timestamp: Date.now() })
    if (this.turns.length > config.contextMaxTurns) {
      this.turns.shift()
    }
  }

  getRecent(): Turn[] {
    const cutoff = Date.now() - WINDOW_MS
    return this.turns.filter((t) => t.timestamp > cutoff)
  }

  /**
   * Format for Claude API messages array.
   * Merges consecutive same-role messages and ensures user-first alternation.
   */
  toClaudeMessages(): Array<{ role: 'user' | 'assistant'; content: string }> {
    const recent = this.getRecent()
    if (recent.length === 0) return []

    const merged: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (const turn of recent) {
      const last = merged[merged.length - 1]
      if (last && last.role === turn.role) {
        last.content += '\n' + turn.content
      } else {
        merged.push({ role: turn.role, content: turn.content })
      }
    }

    // Claude requires first message to be 'user'
    while (merged.length > 0 && merged[0]!.role !== 'user') {
      merged.shift()
    }

    return merged
  }

  get length(): number {
    return this.getRecent().length
  }
}

/**
 * Per-sender context map.
 * Ensures conversation context never bleeds between different senders.
 */
export class ContextManager {
  private contexts = new Map<string, ConversationContext>()

  get size(): number {
    return this.contexts.size
  }

  get(sender: string): ConversationContext {
    if (!this.contexts.has(sender)) {
      this.contexts.set(sender, new ConversationContext())
    }
    return this.contexts.get(sender)!
  }

  persist(): void {
    try {
      const dir = path.dirname(SNAPSHOT_PATH)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const data: Record<string, Turn[]> = {}
      for (const [sender, ctx] of this.contexts) {
        data[sender] = ctx.getRecent()
      }
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(data))
      if (config.debug) console.log('[Context] persisted', this.contexts.size, 'sender contexts')
    } catch (e) {
      console.error('[Context] persist failed:', e)
    }
  }

  static restore(): ContextManager {
    const manager = new ContextManager()
    try {
      if (fs.existsSync(SNAPSHOT_PATH)) {
        const raw = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8')) as Record<string, Turn[]>
        const cutoff = Date.now() - WINDOW_MS
        for (const [sender, turns] of Object.entries(raw)) {
          const ctx = new ConversationContext()
          const recent = turns.filter((t) => t.timestamp > cutoff)
          for (const t of recent) ctx.add(t.role, t.content)
          if (ctx.length > 0) manager.contexts.set(sender, ctx)
        }
        if (config.debug) console.log('[Context] restored', manager.contexts.size, 'sender contexts')
      }
    } catch {
      // Start fresh on any parse error
    }
    return manager
  }
}
