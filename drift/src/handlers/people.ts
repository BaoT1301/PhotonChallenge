import Anthropic from '@anthropic-ai/sdk'
import { getPersonProfile, getMemoriesAboutPerson } from '../memory/db.js'
import { withRetry } from '../retry.js'
import { config } from '../config.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

/** Common topic/category words that are NOT people names */
const TOPIC_WORDS = new Set([
  'work', 'health', 'social', 'goals', 'food', 'travel', 'family', 'school',
  'career', 'relationship', 'gym', 'workout', 'run', 'sleep', 'money', 'project',
  'meeting', 'interview', 'internship', 'job', 'startup', 'tech', 'coding', 'class',
  'professor', 'exam', 'friend', 'home', 'city', 'weekend', 'today', 'yesterday',
])

/**
 * Extracts proper person names from a list of facts and tags.
 * Heuristic: capitalized words that aren't at sentence start and aren't topic words.
 */
export function extractPeopleFromFacts(facts: string[], tags: string[]): string[] {
  const names = new Set<string>()

  // Check tags first — any tag that looks like a proper name (capitalized, single word, not a topic word)
  for (const tag of tags) {
    const t = tag.trim()
    if (
      t.length > 1 &&
      /^[A-Z][a-z]+$/.test(t) &&
      !TOPIC_WORDS.has(t.toLowerCase())
    ) {
      names.add(t)
    }
  }

  // Scan facts for capitalized names that appear mid-sentence
  for (const fact of facts) {
    const words = fact.split(/\s+/)
    for (let i = 1; i < words.length; i++) {
      const word = words[i]!.replace(/[^a-zA-Z]/g, '')
      if (
        word.length > 1 &&
        /^[A-Z][a-z]{1,}$/.test(word) &&
        !TOPIC_WORDS.has(word.toLowerCase())
      ) {
        names.add(word)
      }
    }
  }

  return [...names].slice(0, 5) // cap at 5 per message
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

export async function getPeopleProfile(
  text: string,
  sender: string
): Promise<string> {
  // Extract the name being asked about
  const nameMatch = text.match(
    /(?:who is|tell me about|what do you know about|info on|about)\s+([a-z][a-z\s]{1,20})/i
  )
  const name = nameMatch ? nameMatch[1].trim() : text.trim()

  if (!name) return "who are you asking about?"

  const profile = getPersonProfile(sender, name)

  if (!profile) {
    return `i don't have anything stored about ${name} yet`
  }

  const memories = getMemoriesAboutPerson(sender, name, 10)
  const topics: string[] = profile.common_topics ? JSON.parse(profile.common_topics) : []

  const moodDesc =
    profile.avg_sentiment > 0.3
      ? 'things seem generally positive when you mention them'
      : profile.avg_sentiment < -0.3
      ? 'you often seem stressed or concerned when they come up'
      : 'mixed vibes when they come up'

  const recentMemories = memories
    .slice(0, 5)
    .map((m) => `[${formatDate(m.created_at)}] ${m.raw_text}`)
    .join('\n')

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `You are Drift. The user is asking about someone named ${name} from their life. Give a natural, warm summary of what you know about this person based on their stored memories.

Tone: casual iMessage style. Like a friend recapping what you've heard about this person. Don't use bullet points.

Person stats:
- Mentioned ${profile.mention_count} times
- First came up: ${formatDate(profile.first_mentioned)}
- Last mentioned: ${formatDate(profile.last_mentioned)}
- Common topics: ${topics.join(', ') || 'none tagged'}
- Vibe: ${moodDesc}

Recent memories mentioning ${name}:
${recentMemories || 'none'}`,
      messages: [{ role: 'user', content: `Tell me about ${name}` }],
    })
  )

  return extractText(response) || `you've mentioned ${name} ${profile.mention_count} times, mostly around ${topics.slice(0, 3).join(', ') || 'various things'}`
}

function extractText(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === 'text')
  return block?.type === 'text' ? block.text : ''
}
