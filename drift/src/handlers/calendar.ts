import Anthropic from '@anthropic-ai/sdk'
import { google } from 'googleapis'
import { config } from '../config.js'
import { ConversationContext } from '../context.js'
import { withRetry } from '../retry.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

function getCalendarClient() {
  if (!config.calendarEnabled) return null

  const auth = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret
  )
  auth.setCredentials({ refresh_token: config.google.refreshToken })
  return google.calendar({ version: 'v3', auth })
}

export interface CalendarEvent {
  summary: string
  start: string
  end: string
  location?: string
  description?: string
}

async function fetchEvents(
  startDate: Date,
  endDate: Date
): Promise<CalendarEvent[]> {
  const cal = getCalendarClient()
  if (!cal) return []

  const res = await cal.events.list({
    calendarId: config.google.calendarId,
    timeMin: startDate.toISOString(),
    timeMax: endDate.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 20,
  })

  return (res.data.items ?? []).map((e) => ({
    summary: e.summary ?? 'Untitled',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    location: e.location ?? undefined,
    description: e.description ?? undefined,
  }))
}

function formatEventList(events: CalendarEvent[]): string {
  if (events.length === 0) return 'no events'
  return events
    .map((e) => {
      const start = new Date(e.start)
      const time = isNaN(start.getTime())
        ? e.start
        : start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      const loc = e.location ? ` @ ${e.location}` : ''
      return `${time} — ${e.summary}${loc}`
    })
    .join('\n')
}

export async function calendarQuery(
  text: string,
  context: ConversationContext
): Promise<string> {
  if (!config.calendarEnabled) {
    return "calendar isn't connected yet — add your Google OAuth creds to .env and run `bun run calendar:auth`"
  }

  // Determine date range from the query
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)
  const weekEnd = new Date(todayStart.getTime() + 7 * 24 * 60 * 60 * 1000)

  const t = text.toLowerCase()
  let startDate = todayStart
  let endDate = todayEnd
  let rangeLabel = 'today'

  if (/tomorrow/.test(t)) {
    startDate = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)
    endDate = new Date(todayStart.getTime() + 48 * 60 * 60 * 1000)
    rangeLabel = 'tomorrow'
  } else if (/this week|week/.test(t)) {
    endDate = weekEnd
    rangeLabel = 'this week'
  } else if (/next week/.test(t)) {
    startDate = weekEnd
    endDate = new Date(weekEnd.getTime() + 7 * 24 * 60 * 60 * 1000)
    rangeLabel = 'next week'
  }

  let events: CalendarEvent[] = []
  try {
    events = await fetchEvents(startDate, endDate)
  } catch (e) {
    console.error('[Calendar] fetch failed:', e)
    return "couldn't reach google calendar right now, try again in a sec"
  }

  const eventList = formatEventList(events)
  const messages = context.toClaudeMessages()
  messages.push({ role: 'user', content: text })

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `You are Drift. The user asked about their calendar. Answer naturally in iMessage style — concise, casual, no bullet lists unless there are 3+ events.

Calendar events for ${rangeLabel}:
${eventList}

If there are no events, say so naturally. If there are several, summarize the vibe of the day. Mention any gaps or if it looks heavy/light.`,
      messages,
    })
  )

  return extractText(response) || eventList
}

/** Generate a morning briefing from today's calendar — called by daily cron */
export async function getMorningBriefing(): Promise<string | null> {
  if (!config.calendarEnabled) return null

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)

  try {
    const events = await fetchEvents(todayStart, todayEnd)
    if (events.length === 0) return null

    return `today's calendar:\n${formatEventList(events)}`
  } catch {
    return null
  }
}

function extractText(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === 'text')
  return block?.type === 'text' ? block.text : ''
}
