import Anthropic from '@anthropic-ai/sdk'
import { searchMemories } from '../memory/search.js'
import { ConversationContext } from '../context.js'
import { withRetry } from '../retry.js'
import { config } from '../config.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

export async function recallMemory(
  query: string,
  sender: string,
  context: ConversationContext
): Promise<string> {
  const results = await searchMemories(query, 8, 0.25)

  if (results.length === 0) {
    return "hmm, nothing's coming up on that. can you give me more to go on?"
  }

  const memoryContext = results
    .map((r) => {
      const tags = r.tags ? ` [${r.tags}]` : ''
      const facts = r.extracted_facts
        ? `\n  key facts: ${(JSON.parse(r.extracted_facts) as string[]).join(' | ')}`
        : ''
      const mood = r.sentiment > 0.3 ? ' 😊' : r.sentiment < -0.3 ? ' 😔' : ''
      return `[${formatDate(r.created_at)}${tags}${mood}] (match: ${(r.score * 100).toFixed(0)}%)\n  "${r.raw_text}"${facts}`
    })
    .join('\n\n')

  const messages = context.toClaudeMessages()
  messages.push({ role: 'user', content: query })

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: `You are Drift, a personal memory companion. Answer using ONLY the retrieved memories below — never make stuff up or guess beyond what's there.

Rules:
- Include specific dates naturally ("back on mar 5th you mentioned...")
- If memories only partially match, say what you found and what's missing
- If multiple memories connect, weave them together naturally
- Casual iMessage tone — no bullet lists, no formal structure
- If the match seems weak: "closest thing i've got is..."
- Mood indicators in memories are from sentiment scores, use them if relevant

Retrieved memories (ranked by relevance):
${memoryContext}`,
      messages,
    })
  )

  return extractText(response) || "let me think on that..."
}

function extractText(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === 'text')
  return block?.type === 'text' ? block.text : ''
}
