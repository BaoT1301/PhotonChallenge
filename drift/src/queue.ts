/**
 * Sequential FIFO message queue.
 *
 * The SDK watcher fires handlers concurrently via Promise.all().
 * Without this queue, rapid messages cause race conditions and out-of-order
 * replies on shared state (context window, DB writes).
 */
export class MessageQueue {
  private queue: Array<() => Promise<void>> = []
  private processing = false

  async enqueue(handler: () => Promise<void>): Promise<void> {
    this.queue.push(handler)
    if (!this.processing) {
      await this.drain()
    }
  }

  private async drain(): Promise<void> {
    this.processing = true
    while (this.queue.length > 0) {
      const task = this.queue.shift()!
      try {
        await task()
      } catch (e) {
        console.error('[Queue] handler failed:', e)
        // Don't rethrow — keep draining
      }
    }
    this.processing = false
  }

  get pending(): number {
    return this.queue.length
  }
}
