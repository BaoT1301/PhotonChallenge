import Anthropic from '@anthropic-ai/sdk'
import { saveReminder } from '../memory/db.js'
import { ConversationContext } from '../context.js'
import { withRetry } from '../retry.js'
import { config } from '../config.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

const REMIND_TOOL: Anthropic.Tool = {
  name: 'set_reminder',
  description: 'Parse a reminder request and extract the time and content',
  input_schema: {
    type: 'object' as const,
    properties: {
      content: {
        type: 'string' as const,
        description: 'What to remind about — concise but specific. Keep the original phrasing.',
      },
      fire_at_iso: {
        type: 'string' as const,
        description:
          'ISO 8601 datetime when to fire the reminder (e.g., "2025-03-26T09:00:00"). Use the current date/time as reference.',
      },
      reply: {
        type: 'string' as const,
        description:
          'Casual confirmation like "on it — i\'ll remind you friday at 3pm" or "set for tomorrow morning ✓". Keep it brief.',
      },
    },
    required: ['content', 'fire_at_iso', 'reply'],
  },
}

export async function setReminder(
  text: string,
  sender: string,
  context: ConversationContext
): Promise<string> {
  const now = new Date()
  const messages = context.toClaudeMessages()
  messages.push({ role: 'user', content: text })

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `You are Drift. The user wants to set a reminder. Current date/time: ${now.toISOString()} (${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}).

Use the set_reminder tool to parse when and what. If the time is ambiguous (e.g., "tomorrow"), use 9:00 AM as default. If day is mentioned without time (e.g., "friday"), use 9:00 AM. Resolve relative times ("in 2 hours") against the current time above.`,
      messages,
      tools: [REMIND_TOOL],
      tool_choice: { type: 'tool', name: 'set_reminder' },
    })
  )

  const toolBlock = response.content.find((b) => b.type === 'tool_use') as
    | { type: 'tool_use'; input: { content: string; fire_at_iso: string; reply: string } }
    | undefined

  if (!toolBlock) {
    return "when do you want the reminder? (e.g., 'remind me tomorrow at 3pm to call sarah')"
  }

  const { content, fire_at_iso, reply } = toolBlock.input

  try {
    const fireAt = new Date(fire_at_iso)
    if (isNaN(fireAt.getTime()) || fireAt <= now) {
      return "that time already passed — when do you want the reminder?"
    }
    saveReminder(sender, content, fireAt)
    if (config.debug) console.log(`[Remind] saved: "${content}" at ${fireAt.toISOString()}`)
  } catch (e) {
    console.error('[Remind] DB save failed:', e)
    return "couldn't save that reminder, something went wrong"
  }

  return reply
}
