import cron from 'node-cron'
import type { IMessageSDK } from '@photon-ai/imessage-kit'
import { generateReflection } from './handlers/reflect.js'
import { getMorningBriefing } from './handlers/calendar.js'
import { getDueReminders, markReminderFired } from './memory/db.js'
import { config } from './config.js'

export function setupScheduler(
  sdk: IMessageSDK,
  recipient: string
): { destroy: () => void } {
  // ─── Weekly reflection ── Sunday 7pm ─────────────────────────────────────
  // Dynamic content — must be generated at send time, not stored statically
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

  // ─── Daily morning briefing ── 8:30am every day ───────────────────────────
  const dailyJob = cron.schedule('30 8 * * *', async () => {
    try {
      const calendarNote = await getMorningBriefing()
      const greeting = calendarNote
        ? `morning! ☕\n\n${calendarNote}`
        : "morning! anything on your mind today? ☕"
      await sdk.send(recipient, greeting)
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
        if (config.debug) console.log(`[Scheduler] fired reminder #${reminder.id}: "${reminder.content}"`)
      }
    } catch (e) {
      console.error('[Scheduler] reminder check failed:', e)
    }
  })

  return {
    destroy: () => {
      weeklyJob.stop()
      dailyJob.stop()
      reminderJob.stop()
    },
  }
}
