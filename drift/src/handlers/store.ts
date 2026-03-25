import Anthropic from '@anthropic-ai/sdk'
import { getDB } from '../memory/db.js'
import { getEmbedding } from '../memory/embeddings.js'
import { ConversationContext } from '../context.js'
import { withRetry } from '../retry.js'
import { config } from '../config.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

const STORE_TOOL: Anthropic.Tool = {
  name: 'store_memory',
  description: 'Extract facts from the message and generate a casual reply',
  input_schema: {
    type: 'object' as const,
    properties: {
      facts: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description:
          'Standalone factual statements extracted from the message + context. Resolve pronouns (she → name). Include people, places, events, feelings, decisions, plans. Each fact should stand alone.',
      },
      tags: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description:
          'Short lowercase category tags. Include people names and topics like work, health, social, goals, food, travel, family, school, career, relationship.',
      },
      sentiment: {
        type: 'number' as const,
        description:
          'Emotional tone of the message from -1.0 (very negative/stressed) to 0.0 (neutral) to 1.0 (very positive/excited). Be precise.',
      },
      reply: {
        type: 'string' as const,
        description:
          'A casual 1-2 sentence iMessage-style reply. Match the user\'s energy — if they\'re hype, be hype; if it\'s heavy, be real. Lowercase is fine. No "noted" or "saved" or "got it" ever. Be a friend who actually gets it, not a bot. One follow-up question max.',
      },
    },
    required: ['facts', 'tags', 'sentiment', 'reply'],
  },
}

export async function storeMemory(
  text: string,
  sender: string,
  context: ConversationContext
): Promise<string> {
  const messages = context.toClaudeMessages()
  if (messages.length === 0 || messages[messages.length - 1]!.content !== text) {
    messages.push({ role: 'user', content: text })
  }

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: `You are Drift — a personal memory companion that people text throughout the day. Someone just texted you something happening in their life.

Use the store_memory tool to:
1. Extract key facts (resolve pronouns using conversation context)
2. Tag the topics + people involved
3. Score the emotional tone (-1 to 1)
4. Write a natural reply that matches their vibe

Tone reference: casual, lowercase ok, minimal punctuation. Think "texting a smart friend who actually listens" not "AI assistant confirms input received".`,
      messages,
      tools: [STORE_TOOL],
      tool_choice: { type: 'tool', name: 'store_memory' },
    })
  )

  const toolBlock = response.content.find((b) => b.type === 'tool_use') as
    | { type: 'tool_use'; input: { facts: string[]; tags: string[]; sentiment: number; reply: string } }
    | undefined

  if (!toolBlock) {
    return "heard you — tell me more"
  }

  const { facts, tags, sentiment, reply } = toolBlock.input

  // Embed and persist async — reply goes out immediately
  setImmediate(async () => {
    try {
      const embedding = await getEmbedding(text)
      const db = getDB()
      db.prepare(
        `INSERT INTO memories (raw_text, extracted_facts, embedding, sender, tags, sentiment)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        text,
        JSON.stringify(facts),
        Buffer.from(embedding.buffer),
        sender,
        tags.join(','),
        sentiment
      )

      if (config.debug) {
        console.log(`[Store] saved: ${facts.length} facts, tags: [${tags.join(', ')}], sentiment: ${sentiment}`)
      }
    } catch (e) {
      console.error('[Store] embed/write failed, saving to dead letter queue:', e)
      try {
        getDB()
          .prepare(`INSERT INTO failed_messages (raw_text, sender, error) VALUES (?, ?, ?)`)
          .run(text, sender, String(e))
      } catch (dlqErr) {
        console.error('[Store] dead letter queue also failed:', dlqErr)
      }
    }
  })

  return reply
}
