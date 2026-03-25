import { getAllHabits } from '../memory/db.js'

function daysSince(dateStr: string | null): number {
  if (!dateStr) return Infinity
  const diff = Date.now() - new Date(dateStr).getTime()
  return Math.floor(diff / 86400000)
}

export async function getHabitsOverview(sender: string): Promise<string> {
  const habits = getAllHabits(sender)

  if (habits.length === 0) {
    return "no habits tracked yet — just mention doing something regularly (gym, run, meditate, etc.) and i'll start tracking it"
  }

  const lines: string[] = []

  for (const h of habits) {
    const gap = daysSince(h.last_logged)
    const streakIcon = h.streak >= 7 ? '🔥' : h.streak >= 3 ? '⚡' : '•'
    const gapNote = gap === 0 ? ' (today ✓)' : gap === 1 ? ' (yesterday)' : gap > 2 ? ` (${gap}d ago ⚠️)` : ''
    const bestNote = h.streak === h.best_streak && h.streak > 1 ? ' ← new record!' : h.best_streak > h.streak ? ` / best: ${h.best_streak}` : ''

    lines.push(`${streakIcon} ${h.name}: ${h.streak}-day streak${bestNote}${gapNote} · ${h.total_count} total`)
  }

  return lines.join('\n')
}
