import fs from 'node:fs'
import path from 'node:path'
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
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) return []
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
  }
  return (data.web?.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    description: r.description ?? '',
  }))
}

export async function researchTopic(
  topic: string,
  sender: string,
  context: ConversationContext,
  sendAck: () => Promise<void>
): Promise<{ filePath: string; summary: string }> {
  if (!config.searchEnabled) {
    return {
      filePath: '',
      summary: "web search isn't set up — add BRAVE_API_KEY to .env to enable research mode",
    }
  }

  // Send ack immediately so user isn't staring at silence
  await sendAck()

  // Pull personal context from memories for personalization
  const memoryResults = await searchMemories(topic, 5, 0.2)
  const personalContext = memoryResults
    .map((r) => {
      const facts = r.extracted_facts ? (JSON.parse(r.extracted_facts) as string[]).join(', ') : r.raw_text
      return facts
    })
    .join('\n')

  // Generate 5 diverse search queries
  const queryResponse = await withRetry(() =>
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `Generate exactly 5 diverse search queries for researching the given topic. Return ONLY a JSON array of strings. No explanation.

Make the queries complementary — cover different angles: overview, specific details, recent news, comparisons, practical how-to. Use the user's personal context to personalize where relevant.

User context: ${personalContext || 'none'}`,
      messages: [{ role: 'user', content: topic }],
    })
  )

  let queries: string[] = [topic]
  try {
    const raw = extractText(queryResponse)
    const jsonMatch = raw.match(/\[[\s\S]*\]/)
    if (jsonMatch) queries = JSON.parse(jsonMatch[0]) as string[]
  } catch {
    queries = [topic, `${topic} overview`, `${topic} guide`, `${topic} examples`, `best ${topic}`]
  }

  if (config.debug) console.log('[Research] queries:', queries)

  // Run all queries in parallel
  const resultSets = await Promise.allSettled(queries.slice(0, 5).map((q) => braveSearch(q, 6)))

  // Flatten + deduplicate by URL
  const seen = new Set<string>()
  const allResults: BraveResult[] = []
  for (const set of resultSets) {
    if (set.status === 'fulfilled') {
      for (const r of set.value) {
        if (r.url && !seen.has(r.url)) {
          seen.add(r.url)
          allResults.push(r)
        }
      }
    }
  }

  if (allResults.length === 0) {
    return { filePath: '', summary: "search came back empty — try rephrasing the topic?" }
  }

  const resultsText = allResults
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`)
    .join('\n\n')

  // Synthesize into a structured report
  const reportResponse = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: `You are Drift doing a deep research dive for the user. Synthesize the search results into a comprehensive markdown report.

Format:
# Research: [topic]
*Generated [date] • [N] sources*

## Executive Summary
2-3 sentences: the most important things to know.

## Key Findings
5-8 bullet points covering the most valuable insights. Be specific and opinionated — say what's actually good vs. just listing things.

## Top Resources
3-5 most valuable links with a one-line reason why each is worth clicking.

## Relevant to You
1-2 sentences connecting this research to the user's personal context (if any). If no context, skip this section.

---
Be direct and opinionated. This isn't Wikipedia — tell the user what actually matters.

User's personal context:
${personalContext || 'none available'}

Search results (${allResults.length} unique sources):
${resultsText}`,
      messages: [{ role: 'user', content: `Research: ${topic}` }],
    })
  )

  const reportContent = extractText(reportResponse)

  // Save to file
  const dataDir = path.join(process.cwd(), 'data')
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  const fileName = `research-${Date.now()}.md`
  const filePath = path.join(dataDir, fileName)
  fs.writeFileSync(filePath, reportContent)

  // Short text summary (2 sentences)
  const summaryResponse = await withRetry(() =>
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: 'Summarize this research report in exactly 2 casual iMessage-style sentences. Start with the most important takeaway.',
      messages: [{ role: 'user', content: reportContent }],
    })
  )

  const summary = extractText(summaryResponse) || `research on "${topic}" complete — ${allResults.length} sources synthesized`

  return { filePath, summary }
}

function extractText(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === 'text')
  return block?.type === 'text' ? block.text : ''
}
