import Anthropic from '@anthropic-ai/sdk'
import { ConversationContext } from '../context.js'
import { withRetry } from '../retry.js'
import { config } from '../config.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

// Handle simple greetings without an API call
const QUICK_REPLIES: Array<[RegExp, string]> = [
  [/^(gm|good morning)\b/i, 'morning! what\'s on your mind today? ☕'],
  [/^(gn|good night|goodnight)\b/i, 'sleep well — catch you tomorrow 🌙'],
  [/^(thanks|thank you|thx|ty)\b/i, 'anytime 🤝'],
  [/^(lol|haha|lmao|😂|💀)\s*$/i, 'lol'],
  [/^(hi|hey|hello|sup|yo)\s*[!.]*$/i, 'hey! what\'s good?'],
]

export async function chatReply(text: string, context: ConversationContext): Promise<string> {
  // Quick replies — no API call needed
  for (const [pattern, reply] of QUICK_REPLIES) {
    if (pattern.test(text.trim())) return reply
  }

  const messages = context.toClaudeMessages()
  if (messages.length === 0 || messages[messages.length - 1]!.content !== text) {
    messages.push({ role: 'user', content: text })
  }

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      system: `You are Drift — a chill personal memory companion. Right now you're just vibing. No need to remember anything, just have a real conversation.

Tone: casual, lowercase is fine, match their energy. Short. Don't be cringe or over-eager. If they're joking around, joke back. If they're being real, be real.`,
      messages,
    })
  )

  return extractText(response) || '👍'
}

function extractText(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === 'text')
  return block?.type === 'text' ? block.text : ''
}
