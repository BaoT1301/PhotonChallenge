import { getMemoryCount, getTopTags } from '../memory/db.js'
import { getMoodTrend } from '../memory/search.js'

export async function getStats(sender: string): Promise<string> {
  const total = getMemoryCount(sender)

  if (total === 0) {
    return "nothing stored yet — start texting me stuff and i'll remember it all"
  }

  const topTags = getTopTags(sender, 6)
  const moodWeek = getMoodTrend(sender, 7)
  const moodMonth = getMoodTrend(sender, 30)

  const tagLine =
    topTags.length > 0
      ? 'top topics: ' + topTags.map((t) => `${t.tag} (${t.count})`).join(', ')
      : ''

  const moodDesc = (avg: number) =>
    avg > 0.4 ? 'mostly positive' : avg < -0.3 ? 'kinda rough' : 'pretty neutral'

  const lines: string[] = [
    `you've got ${total} ${total === 1 ? 'memory' : 'memories'} stored`,
  ]

  if (tagLine) lines.push(tagLine)

  if (moodWeek.count > 0) {
    lines.push(`vibe this week: ${moodDesc(moodWeek.avg)} (${moodWeek.count} entries)`)
  }
  if (moodMonth.count > moodWeek.count) {
    lines.push(`vibe this month: ${moodDesc(moodMonth.avg)}`)
  }

  return lines.join('\n')
}
