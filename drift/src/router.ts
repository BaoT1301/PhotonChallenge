import Anthropic from '@anthropic-ai/sdk'
import { ConversationContext } from './context.js'
import { storeMemory } from './handlers/store.js'
import { recallMemory } from './handlers/recall.js'
import { generateReflection } from './handlers/reflect.js'
import { chatReply } from './handlers/chat.js'
import { setReminder } from './handlers/remind.js'
import { calendarQuery } from './handlers/calendar.js'
import { webSearch } from './handlers/search.js'
import { forgetLast } from './handlers/forget.js'
import { getStats } from './handlers/stats.js'
import { exportMemories } from './handlers/export.js'
import { withRetry } from './retry.js'
import { config } from './config.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

type Intent =
  | 'store'
  | 'recall'
  | 'reflect'
  | 'chat'
  | 'remind'
  | 'calendar'
  | 'search'
  | 'forget'
  | 'stats'
  | 'export'

/**
 * Local regex classification — handles ~70% of messages with zero API cost.
 * Returns null for ambiguous cases that need LLM fallback.
 */
function localClassify(text: string): Intent | null {
  const t = text.toLowerCase().trim()

  // Forget / delete last memory
  if (/^(forget that|delete that|remove that|undo|never mind that)\s*[.!]*$/.test(t)) return 'forget'

  // Stats
  if (/^(stats|my stats|how many memories|memory count|show stats)\s*[?!.]*$/.test(t)) return 'stats'

  // Export
  if (/^(export|export memories|download memories|send my memories|backup)\s*[?!.]*$/.test(t)) return 'export'

  // Reminder — "remind me", "set a reminder", "don't let me forget"
  if (/\b(remind me|set a reminder|don'?t let me forget|ping me)\b/.test(t)) return 'remind'

  // Calendar — "what's on my calendar", "my schedule", "when is", etc.
  if (
    /\b(calendar|schedule|what'?s? (on|happening|going on)|my day|my week|meetings?|events?)\b/.test(t) &&
    !/remember|saved|told you/.test(t)
  )
    return 'calendar'

  // Recall — questions about the past
  if (/^(what|when|where|who|how|did i|do i|have i|remind me about|tell me about)\b/.test(t)) return 'recall'
  if (/\?$/.test(t) && t.length < 150) return 'recall'
  if (/\b(remember|last time|earlier|mentioned|you said|do you know)\b/.test(t)) return 'recall'

  // Reflect — summary / pattern requests
  if (/^(weekly|summary|reflect|review|digest|wrap.?up|look back|my week)\b/.test(t)) return 'reflect'
  if (/\b(how.*(my|this).*(week|month)|pattern|trend|overview|vibe check)\b/.test(t)) return 'reflect'

  // Search — explicit web search / job requests
  if (
    /\b(search|find me|look up|google|jobs?|internships?|opportunities?|companies?|research)\b/.test(t)
  )
    return 'search'

  // Chat — greetings and short acks
  if (/^(hey|hi|hello|thanks|thank you|ok|okay|good morning|gm|gn|sup|yo|lol|haha|😂|💀)\s*[!.]*$/i.test(t))
    return 'chat'

  // Store — anything substantial without a question mark is probably a memory
  if (t.length > 20 && !t.includes('?')) return 'store'

  return null
}

/**
 * LLM fallback for genuinely ambiguous messages (~30% of cases).
 */
async function llmClassify(text: string, context: ConversationContext): Promise<Intent> {
  const messages = context.toClaudeMessages()
  messages.push({ role: 'user', content: text })

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system: `Classify the user's message. Reply with ONLY one word from this list: store, recall, reflect, chat, remind, calendar, search, forget, stats, export

- store: sharing something that happened, a thought, feeling, update, or observation
- recall: asking about something from the past, "what did I say about...", memory search
- reflect: wanting a weekly/monthly summary, patterns, how they've been doing
- chat: greeting, small talk, banter, casual conversation
- remind: setting a reminder for a future time
- calendar: asking about their schedule, events, meetings
- search: wanting to search the web, find jobs/opportunities/info
- forget: wants to delete/remove the last memory
- stats: wants to see their memory count or statistics
- export: wants to download/export all their memories`,
      messages,
    })
  )

  const word =
    response.content.find((b) => b.type === 'text')?.type === 'text'
      ? (response.content.find((b) => b.type === 'text') as { type: 'text'; text: string }).text
          .trim()
          .toLowerCase()
      : 'store'

  const valid: Intent[] = ['store', 'recall', 'reflect', 'chat', 'remind', 'calendar', 'search', 'forget', 'stats', 'export']
  return valid.includes(word as Intent) ? (word as Intent) : 'store'
}

/**
 * Main message handler — routes each message to the right handler.
 */
export async function handleMessage(
  text: string,
  sender: string,
  context: ConversationContext,
  sdk: { send: (to: string, content: string | { files: string[] }) => Promise<unknown> }
): Promise<string> {
  if (!text || text.trim().length === 0) return '👍'

  const intent = localClassify(text) ?? (await llmClassify(text, context))

  if (config.debug) {
    console.log(`[Router] "${text.slice(0, 60)}..." → ${intent}`)
  }

  switch (intent) {
    case 'store':
      return storeMemory(text, sender, context)

    case 'recall':
      return recallMemory(text, sender, context)

    case 'reflect':
      return generateReflection(sender)

    case 'chat':
      return chatReply(text, context)

    case 'remind':
      return setReminder(text, sender, context)

    case 'calendar':
      return calendarQuery(text, context)

    case 'search':
      return webSearch(text, sender, context)

    case 'forget':
      return forgetLast(sender)

    case 'stats':
      return getStats(sender)

    case 'export': {
      const result = await exportMemories(sender)
      if ('filePath' in result) {
        // Send the file back as an attachment
        try {
          await sdk.send(sender, { files: [result.filePath] })
          return result.reply
        } catch {
          return result.reply + ' (file send failed — try again)'
        }
      }
      return result.reply
    }
  }
}
