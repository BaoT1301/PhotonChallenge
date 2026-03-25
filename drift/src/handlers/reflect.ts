import Anthropic from '@anthropic-ai/sdk'
import { getRecentMemories, getMoodTrend } from '../memory/search.js'
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

export async function generateReflection(sender: string): Promise<string> {
  const memories = getRecentMemories(7, sender)
  const mood = getMoodTrend(sender, 7)

  if (memories.length === 0) {
    return "you haven't shared much this week — no worries, i'll be here. something good happen today?"
  }

  const moodLabel =
    mood.avg > 0.3 ? 'generally positive' : mood.avg < -0.3 ? 'a bit rough' : 'mixed'

  const memoryDump = memories
    .map((m) => {
      const tags = m.tags ? ` [${m.tags}]` : ''
      const sentimentIcon = m.sentiment > 0.3 ? '+' : m.sentiment < -0.3 ? '-' : '~'
      return `[${formatDate(m.created_at)}${tags}] (${sentimentIcon}) ${m.raw_text}`
    })
    .join('\n')

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: `You are Drift. Generate a weekly reflection based on everything the user shared this week.

Vibe: like that one friend who actually remembers what you told them and brings it back in a real way. Casual, warm, no bullet points. Under 160 words — this is an iMessage not an essay.

Format:
- Start with "hey, here's your week —" (no emoji required)
- 2-3 key themes or moments
- If any emotion patterns showed up (sentiment: ${moodLabel} overall), mention it naturally
- Any recurring people or topics
- End with ONE real question that might spark actual reflection

This week's mood score was ${mood.avg.toFixed(2)} out of 1.0 (${moodLabel}).
Total entries: ${memories.length}

Memories (most recent last):
${memoryDump}`,
      messages: [{ role: 'user', content: 'give me my weekly reflection' }],
    })
  )

  return extractText(response) || "quiet week — let's make next one count 💪"
}

function extractText(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === 'text')
  return block?.type === 'text' ? block.text : ''
}
