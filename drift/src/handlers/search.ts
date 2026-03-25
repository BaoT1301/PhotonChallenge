import Anthropic from '@anthropic-ai/sdk'
import { searchMemories } from '../memory/search.js'
import { ConversationContext } from '../context.js'
import { withRetry } from '../retry.js'
import { config } from '../config.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

interface BraveResult {
  title: string
  url: string
  description: string
}

async function braveSearch(query: string, count = 8): Promise<BraveResult[]> {
  if (!config.braveApiKey) return []

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&search_lang=en`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': config.braveApiKey,
    },
  })

  if (!res.ok) throw new Error(`Brave Search API error: ${res.status}`)

  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
  }
  return (data.web?.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    description: r.description ?? '',
  }))
}

export async function webSearch(
  text: string,
  sender: string,
  context: ConversationContext
): Promise<string> {
  if (!config.searchEnabled) {
    return "web search isn't set up yet — add a BRAVE_API_KEY to .env to enable it"
  }

  // Pull relevant memories to personalize the search
  const memoryResults = await searchMemories(text, 5, 0.25)
  const personalContext = memoryResults
    .map((r) => {
      const facts = r.extracted_facts ? (JSON.parse(r.extracted_facts) as string[]).join(', ') : r.raw_text
      return facts
    })
    .join('\n')

  // Build a smarter search query using Claude + personal context
  const queryResponse = await withRetry(() =>
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: `Based on the user's request and their personal context, generate the best web search query. Return ONLY the search query string, nothing else.

User's personal context (from their memory):
${personalContext || 'none available'}`,
      messages: [{ role: 'user', content: text }],
    })
  )

  const searchQuery = extractText(queryResponse).trim() || text

  if (config.debug) console.log(`[Search] query: "${searchQuery}"`)

  let results: BraveResult[] = []
  try {
    results = await braveSearch(searchQuery, 8)
  } catch (e) {
    console.error('[Search] Brave API error:', e)
    return "search is having issues right now, try again in a bit"
  }

  if (results.length === 0) {
    return "couldn't find anything good on that — maybe rephrase it?"
  }

  const resultsText = results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
    .join('\n\n')

  const messages = context.toClaudeMessages()
  messages.push({ role: 'user', content: text })

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: `You are Drift — a personal assistant who just did a web search for the user. Answer their question using the search results, with context from what you know about them.

Be like that friend who's good at research — opinionated about which results are actually worth their time, explain WHY each pick is good for them specifically. Include the actual URLs for anything worth clicking.

User's personal context from memory:
${personalContext || 'none available'}

Search results for: "${searchQuery}"
${resultsText}`,
      messages,
    })
  )

  return extractText(response) || "found some stuff but couldn't parse it, try again"
}

function extractText(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === 'text')
  return block?.type === 'text' ? block.text : ''
}
