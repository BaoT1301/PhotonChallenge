import fs from 'node:fs'
import path from 'node:path'
import { getAllMemoriesForExport } from '../memory/db.js'

export async function exportMemories(sender: string): Promise<{ filePath: string; reply: string } | { reply: string }> {
  const memories = getAllMemoriesForExport(sender)

  if (memories.length === 0) {
    return { reply: "nothing to export yet — share some memories first!" }
  }

  const lines: string[] = [
    `# Drift — Memory Export`,
    `Exported: ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
    `Total memories: ${memories.length}`,
    '',
    '---',
    '',
  ]

  for (const m of memories) {
    const date = new Date(m.created_at).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
    const tags = m.tags ? ` [${m.tags}]` : ''
    const mood = m.sentiment > 0.3 ? ' 😊' : m.sentiment < -0.3 ? ' 😔' : ''

    lines.push(`### ${date}${tags}${mood}`)
    lines.push(m.raw_text)

    if (m.extracted_facts) {
      try {
        const facts = JSON.parse(m.extracted_facts) as string[]
        if (facts.length > 0) {
          lines.push('')
          lines.push('**Facts extracted:**')
          for (const f of facts) lines.push(`- ${f}`)
        }
      } catch {
        // skip malformed facts
      }
    }
    lines.push('')
  }

  const exportDir = path.join(process.cwd(), 'data')
  const fileName = `drift-export-${Date.now()}.md`
  const filePath = path.join(exportDir, fileName)

  fs.writeFileSync(filePath, lines.join('\n'))

  return {
    filePath,
    reply: `here's your memory export — ${memories.length} entries ✓`,
  }
}
