import Anthropic from '@anthropic-ai/sdk'
import { ConversationContext } from '../context.js'
import { withRetry } from '../retry.js'
import { config } from '../config.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi

export function extractUrls(text: string): string[] {
  return [...new Set(text.match(URL_REGEX) ?? [])]
}

async function fetchPageText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) return null

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return null

    const html = await res.text()

    // Strip scripts, styles, nav, footer first
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      // Strip remaining tags
      .replace(/<[^>]+>/g, ' ')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim()

    // Trim to 5000 chars to stay within token budget
    return stripped.slice(0, 5000) || null
  } catch {
    return null
  }
}

export interface LinkSummaryResult {
  reply: string
  memoryText: string
}

export async function summarizeLink(
  url: string,
  userText: string,
  sender: string,
  context: ConversationContext
): Promise<LinkSummaryResult> {
  const pageText = await fetchPageText(url)

  if (!pageText) {
    return {
      reply: "couldn't read that page (might be paywalled or blocked) — what's it about?",
      memoryText: `shared a link: ${url}`,
    }
  }

  const messages = context.toClaudeMessages()
  const prompt = userText.replace(url, '').trim()
  messages.push({
    role: 'user',
    content: prompt ? `${prompt}\n\nLink: ${url}` : `Summarize this link: ${url}`,
  })

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: `You are Drift. The user shared a link. Give them a useful tl;dr in iMessage style — casual, concise, opinionated. 2-4 sentences max. If it's an article, extract the key point. If it's a job posting, highlight the key details. If it's a product, call out what's actually interesting about it.

Also end with a single line starting with "MEMORY:" containing a short factual note to store (e.g., "MEMORY: shared article about X, key point: Y").

Page content:
${pageText}`,
      messages,
    })
  )

  const raw = extractText(response)

  // Split reply from memory tag
  const memoryMatch = raw.match(/MEMORY:\s*(.+)$/im)
  const reply = raw.replace(/MEMORY:.*$/im, '').trim()
  const memoryText = memoryMatch ? memoryMatch[1].trim() : `shared a link: ${url}`

  return { reply: reply || "interesting link!", memoryText }
}

function extractText(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === 'text')
  return block?.type === 'text' ? block.text : ''
}
