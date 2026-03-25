import cron from 'node-cron'
import Anthropic from '@anthropic-ai/sdk'
import type { IMessageSDK } from '@photon-ai/imessage-kit'
import { generateReflection } from './handlers/reflect.js'
import { generateSmartMorning } from './handlers/morning.js'
import { getDueReminders, markReminderFired, getDistinctSenders, getAgentState, setAgentState } from './memory/db.js'
import { getMoodTrend, getRecentMemories } from './memory/search.js'
import { withRetry } from './retry.js'
import { config } from './config.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

export function setupScheduler(
  sdk: IMessageSDK,
  recipient: string
): { destroy: () => void } {

  // ─── Weekly reflection ── Sunday 7pm ─────────────────────────────────────
  const weeklyJob = cron.schedule('0 19 * * 0', async () => {
    console.log('[Scheduler] generating weekly reflection...')
    try {
      const reflection = await generateReflection(recipient)
      await sdk.send(recipient, reflection)
      console.log('[Scheduler] weekly reflection sent')
    } catch (e) {
      console.error('[Scheduler] weekly reflection failed:', e)
    }
  })

  // ─── Smart morning briefing ── 8:30am every day ───────────────────────────
  const dailyJob = cron.schedule('30 8 * * *', async () => {
    try {
      const briefing = await generateSmartMorning(recipient)
      await sdk.send(recipient, briefing)
      console.log('[Scheduler] morning briefing sent')
    } catch (e) {
      console.error('[Scheduler] morning briefing failed:', e)
    }
  })

  // ─── Reminder checker ── every minute ─────────────────────────────────────
  const reminderJob = cron.schedule('* * * * *', async () => {
    try {
      const due = getDueReminders()
      for (const reminder of due) {
        await sdk.send(reminder.sender, `⏰ reminder: ${reminder.content}`)
        markReminderFired(reminder.id)
        if (config.debug) console.log(`[Scheduler] fired reminder #${reminder.id}`)
      }
    } catch (e) {
      console.error('[Scheduler] reminder check failed:', e)
    }
  })

  // ─── Proactive mood check-in ── every day at 6pm ─────────────────────────
  const moodCheckJob = cron.schedule('0 18 * * *', async () => {
    try {
      const senders = getDistinctSenders()

      for (const sender of senders) {
        const mood = getMoodTrend(sender, 3)

        // Only check-in if 3+ entries and consistently negative
        if (mood.count < 3 || mood.avg >= -0.3) continue

        // Don't spam — check if we already sent a check-in in the last 48 hours
        const lastCheckin = getAgentState(`last_checkin_${sender}`)
        if (lastCheckin) {
          const hoursAgo = (Date.now() - new Date(lastCheckin).getTime()) / 3600000
          if (hoursAgo < 48) continue
        }

        // Generate a personalized check-in based on recent memories
        const recentMemories = getRecentMemories(3, sender)
        const memoryContext = recentMemories.map((m) => m.raw_text).join('\n')

        const response = await withRetry(() =>
          client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 100,
            system: `You are Drift. You've noticed this person has been sharing things that feel heavy or stressful lately. Send a genuine, brief check-in message.

1-2 sentences max. Casual. Don't be overly therapist-y or dramatic. Just check in like a friend who noticed. Reference something specific from their recent messages if possible.

Recent messages context:
${memoryContext}`,
            messages: [{ role: 'user', content: 'generate check-in' }],
          })
        )

        const checkin = response.content.find((b) => b.type === 'text')?.type === 'text'
          ? (response.content.find((b) => b.type === 'text') as { type: 'text'; text: string }).text
          : "hey, things have seemed a bit heavy lately — you good?"

        await sdk.send(sender, checkin)
        setAgentState(`last_checkin_${sender}`, new Date().toISOString())
        console.log(`[Scheduler] sent mood check-in to ${sender}`)
      }
    } catch (e) {
      console.error('[Scheduler] mood check-in failed:', e)
    }
  })

  return {
    destroy: () => {
      weeklyJob.stop()
      dailyJob.stop()
      reminderJob.stop()
      moodCheckJob.stop()
    },
  }
}
