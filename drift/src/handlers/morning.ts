import Anthropic from '@anthropic-ai/sdk'
import { getRecentMemories } from '../memory/search.js'
import { getMoodTrend } from '../memory/search.js'
import { getDueReminders, getOpenLoops } from '../memory/db.js'
import { getMorningBriefing } from './calendar.js'
import { withRetry } from '../retry.js'
import { config } from '../config.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

export async function generateSmartMorning(sender: string): Promise<string> {
  // Gather all context in parallel
  const [yesterdayMemories, moodTrend, dueReminders, openLoops, calendarNote] = await Promise.all([
    Promise.resolve(getRecentMemories(1, sender)),
    Promise.resolve(getMoodTrend(sender, 7)),
    Promise.resolve(getDueReminders().filter((r) => r.sender === sender)),
    Promise.resolve(getOpenLoops(sender, 5)),
    getMorningBriefing().catch(() => null),
  ])

  // If nothing to say, send a simple greeting
  if (
    yesterdayMemories.length === 0 &&
    dueReminders.length === 0 &&
    openLoops.length === 0 &&
    !calendarNote
  ) {
    return "morning! ☀️ anything on your mind today?"
  }

  const yesterdayText =
    yesterdayMemories.length > 0
      ? yesterdayMemories.map((m) => `- ${m.raw_text}`).join('\n')
      : 'nothing shared yesterday'

  const remindersText =
    dueReminders.length > 0
      ? dueReminders.map((r) => `- ${r.content}`).join('\n')
      : 'none'

  const openLoopsText =
    openLoops.length > 0
      ? openLoops.map((o) => `- ${o.raw_text}`).join('\n')
      : 'none'

  const moodDesc =
    moodTrend.avg > 0.3 ? 'pretty solid' : moodTrend.avg < -0.3 ? 'a bit rough' : 'mixed'

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 250,
      system: `You are Drift. Generate a personalized morning message for the user. Keep it under 100 words — this is an iMessage, not an email.

Tone: warm, casual, like a friend who's been paying attention. Don't list everything robotically — weave it together naturally.

Include (only if relevant and interesting):
1. A quick nod to yesterday if something notable happened
2. Today's calendar highlights (if any)
3. Any reminders due today (mention them conversationally, not as a list)
4. Any open loops from recent days worth nudging on
5. Mood context only if there's a clear trend worth naming

Always end with "morning! ☀️" or a variation — keep it warm.

Context:
Yesterday's memories: ${yesterdayText}
Calendar today: ${calendarNote ?? 'no events / not connected'}
Reminders due: ${remindersText}
Open loops (recent unresolved intentions): ${openLoopsText}
7-day mood: ${moodDesc} (${moodTrend.count} entries, avg: ${moodTrend.avg.toFixed(2)})`,
      messages: [{ role: 'user', content: 'generate morning briefing' }],
    })
  )

  return extractText(response) || "morning! ☀️ what's on your plate today?"
}

function extractText(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === 'text')
  return block?.type === 'text' ? block.text : ''
}
