import { deleteLastMemory, getMemoryCount } from '../memory/db.js'

export async function forgetLast(sender: string): Promise<string> {
  const deleted = deleteLastMemory(sender)
  if (!deleted) {
    return "nothing to forget — you haven't shared anything yet"
  }
  const remaining = getMemoryCount(sender)
  return `done, that one's gone. you've got ${remaining} ${remaining === 1 ? 'memory' : 'memories'} left`
}
