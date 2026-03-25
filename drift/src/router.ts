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
import { researchTopic } from './handlers/research.js'
import { getPeopleProfile } from './handlers/people.js'
import { getHabitsOverview } from './handlers/habits.js'
import { extractUrls, summarizeLink } from './handlers/link.js'
import { withRetry } from './retry.js'
import { config } from './config.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

type Intent =
  | 'store' | 'recall' | 'reflect' | 'chat'
  | 'remind' | 'calendar' | 'search' | 'research'
  | 'forget' | 'stats' | 'export'
  | 'people' | 'habits' | 'link'

function localClassify(text: string): Intent | null {
  const t = text.toLowerCase().trim()

  // Link — check first since URLs are unambiguous
  if (/https?:\/\//.test(t)) return 'link'

  // Forget
  if (/^(forget that|delete that|remove that|undo that|never mind that)\s*[.!]*$/.test(t)) return 'forget'

  // Stats
  if (/^(stats|my stats|how many memories|memory count|show stats)\s*[?!.]*$/.test(t)) return 'stats'

  // Export
  if (/^(export|export memories|download memories|send my memories|backup)\s*[?!.]*$/.test(t)) return 'export'

  // Habits
  if (/\b(habit|habits|streak|streaks|my streak|how.*streak|gym streak|run streak)\b/.test(t)) return 'habits'

  // People profiles
  if (/\b(who is|tell me about|what do you know about|info on)\b/.test(t)) return 'people'

  // Research mode — deep dive
  if (/^(research|deep dive|research mode|deep research|investigate|look into)\s*:?\s*\S/.test(t)) return 'research'

  // Reminder
  if (/\b(remind me|set a reminder|don'?t let me forget|ping me)\b/.test(t)) return 'remind'

  // Calendar
  if (
    /\b(calendar|schedule|what'?s? (on|happening|going on)|my day|my week|meetings?|events?)\b/.test(t) &&
    !/remember|saved|told you/.test(t)
  ) return 'calendar'

  // Recall
  if (/^(what|when|where|who|how|did i|do i|have i|remind me about|tell me about)\b/.test(t)) return 'recall'
  if (/\?$/.test(t) && t.length < 150) return 'recall'
  if (/\b(remember|last time|earlier|mentioned|you said|do you know)\b/.test(t)) return 'recall'

  // Reflect
  if (/^(weekly|summary|reflect|review|digest|wrap.?up|look back|my week)\b/.test(t)) return 'reflect'
  if (/\b(how.*(my|this).*(week|month)|pattern|trend|overview|vibe check)\b/.test(t)) return 'reflect'

  // Search — explicit
  if (/\b(search|find me|look up|google|jobs?|internships?|opportunities?|companies?)\b/.test(t)) return 'search'

  // Chat
  if (/^(hey|hi|hello|thanks|thank you|ok|okay|good morning|gm|gn|sup|yo|lol|haha|😂|💀)\s*[!.]*$/i.test(t)) return 'chat'

  // Store — substantial text without a question mark
  if (t.length > 20 && !t.includes('?')) return 'store'

  return null
}

async function llmClassify(text: string, context: ConversationContext): Promise<Intent> {
  const messages = context.toClaudeMessages()
  messages.push({ role: 'user', content: text })

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system: `Classify the user's message intent. Reply with ONLY one word.

store    — sharing something that happened, a thought, feeling, or update
recall   — asking about something from the past or searching memory
reflect  — wanting a weekly/monthly summary or patterns
chat     — greeting, small talk, banter
remind   — setting a future reminder
calendar — asking about schedule or events
search   — searching the web for info or jobs
research — deep research dive on a topic (multi-source)
forget   — wants to delete the last memory
stats    — wants memory count or statistics
export   — wants to download all memories
people   — asking about a specific person ("who is X", "tell me about X")
habits   — asking about habit streaks or tracking
link     — message contains a URL`,
      messages,
    })
  )

  const word = response.content.find((b) => b.type === 'text')?.type === 'text'
    ? (response.content.find((b) => b.type === 'text') as { type: 'text'; text: string }).text.trim().toLowerCase()
    : 'store'

  const valid: Intent[] = ['store', 'recall', 'reflect', 'chat', 'remind', 'calendar', 'search', 'research', 'forget', 'stats', 'export', 'people', 'habits', 'link']
  return valid.includes(word as Intent) ? (word as Intent) : 'store'
}

export async function handleMessage(
  text: string,
  sender: string,
  context: ConversationContext,
  sdk: { send: (to: string, content: string | { files: string[] }) => Promise<unknown> }
): Promise<string> {
  if (!text || text.trim().length === 0) return '👍'

  // Link detection is deterministic — handle before classification
  const urls = extractUrls(text)
  if (urls.length > 0) {
    const result = await summarizeLink(urls[0]!, text, sender, context)
    // Store the summary as a memory via normal store flow
    await storeMemory(result.memoryText, sender, context)
    return result.reply
  }

  const intent = localClassify(text) ?? (await llmClassify(text, context))

  if (config.debug) console.log(`[Router] "${text.slice(0, 60)}..." → ${intent}`)

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

    case 'research': {
      // Strip the trigger word to get the actual topic
      const topic = text.replace(/^(research|deep dive|research mode|deep research|investigate|look into)\s*:?\s*/i, '').trim()
      const result = await researchTopic(topic, sender, context, async () => {
        await sdk.send(sender, 'on it, digging in... 🔍')
      })
      if (result.filePath) {
        try { await sdk.send(sender, { files: [result.filePath] }) } catch { /* ignore file send failure */ }
      }
      return result.summary
    }

    case 'forget':
      return forgetLast(sender)

    case 'stats':
      return getStats(sender)

    case 'export': {
      const result = await exportMemories(sender)
      if ('filePath' in result) {
        try { await sdk.send(sender, { files: [result.filePath] }) } catch { /* ignore */ }
        return result.reply
      }
      return result.reply
    }

    case 'people':
      return getPeopleProfile(text, sender)

    case 'habits':
      return getHabitsOverview(sender)

    case 'link': {
      // Already handled above but router might land here via LLM classify
      const urlsAgain = extractUrls(text)
      if (urlsAgain.length > 0) {
        const result = await summarizeLink(urlsAgain[0]!, text, sender, context)
        await storeMemory(result.memoryText, sender, context)
        return result.reply
      }
      return storeMemory(text, sender, context)
    }
  }
}
