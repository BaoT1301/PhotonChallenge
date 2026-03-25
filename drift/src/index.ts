import { IMessageSDK } from '@photon-ai/imessage-kit'
import { config } from './config.js'
import { MessageQueue } from './queue.js'
import { ContextManager } from './context.js'
import { handleMessage } from './router.js'
import { initDB, getDB, getMemoryCount, getPendingFailedMessages, incrementFailedRetry, deleteFailedMessage } from './memory/db.js'
import { warmupEmbeddings, getEmbedding } from './memory/embeddings.js'
import { setupScheduler } from './scheduler.js'
import { driftLogger } from './plugins/drift-logger.js'
import { RateLimitError } from './retry.js'

// Per-sender debounce state
interface Batch {
  messages: string[]
  timer: ReturnType<typeof setTimeout>
}
const pendingBatches = new Map<string, Batch>()

async function retryFailedMessages(): Promise<void> {
  const failed = getPendingFailedMessages(3)
  if (failed.length === 0) return

  console.log(`⏳ Retrying ${failed.length} failed message(s) from previous run...`)
  let recovered = 0

  for (const msg of failed) {
    try {
      const embedding = await getEmbedding(msg.raw_text)
      getDB()
        .prepare(
          `INSERT INTO memories (raw_text, embedding, sender, tags, sentiment)
           VALUES (?, ?, ?, ?, 0)`
        )
        .run(msg.raw_text, Buffer.from(embedding.buffer), msg.sender, null)
      deleteFailedMessage(msg.id)
      recovered++
    } catch (e) {
      incrementFailedRetry(msg.id)
      console.warn(`[Retry] failed message #${msg.id} still failing:`, e)
    }
  }

  if (recovered > 0) console.log(`✓ Recovered ${recovered} failed message(s)`)
}

const ONBOARDING_MSG = `hey! i'm drift — your personal memory companion 🌊

just text me what's happening in your life and i'll remember it all. ask me anything later and i'll dig it up.

you can also:
• "remind me to [x] on [day]" — i'll ping you
• "what did i say about [x]?" — search your memories
• "my weekly review" — Sunday reflection
• "stats" — see your memory count
• "search [anything]" — web search, personalized to you

let's go — what's on your mind?`

async function main() {
  console.log('🌊 Drift starting up...')
  console.log(`   Phone:    ${config.myNumber}`)
  console.log(`   Senders:  ${[...config.allowedSenders].join(', ')}`)
  console.log(`   Calendar: ${config.calendarEnabled ? '✓ connected' : '✗ not configured'}`)
  console.log(`   Search:   ${config.searchEnabled ? '✓ enabled' : '✗ no API key'}`)
  console.log(`   Debounce: ${config.debounceMs > 0 ? `${config.debounceMs / 1000}s` : 'disabled'}`)
  console.log(`   Debug:    ${config.debug}`)
  console.log()

  // Initialize database
  const db = initDB()
  console.log('✓ Database ready (WAL mode)')

  // Warm up embedding model — avoids cold-start delay on first message
  await warmupEmbeddings()

  // Retry any messages that failed to embed on a previous run
  await retryFailedMessages()

  // Initialize SDK
  const plugins = config.debug ? [driftLogger] : []
  const sdk = new IMessageSDK({
    debug: config.debug,
    watcher: {
      pollInterval: 2000,
      excludeOwnMessages: true,
    },
    plugins,
  })
  console.log('✓ SDK initialized')

  // Restore per-sender conversation contexts
  const contextManager = ContextManager.restore()
  console.log(`✓ Contexts restored (${contextManager.size} senders)`)

  // Sequential message queue — prevents race conditions
  const queue = new MessageQueue()

  // ─── Message Handler ─────────────────────────────────────────────────────
  async function processMessage(text: string, sender: string): Promise<void> {
    const context = contextManager.get(sender)

    // First message from this sender — send onboarding
    const isFirstMessage = getMemoryCount(sender) === 0 && context.length === 0
    if (isFirstMessage) {
      await sdk.send(sender, ONBOARDING_MSG)
      // Still process their actual message after the intro
    }

    context.add('user', text)
    let reply: string
    try {
      reply = await handleMessage(text, sender, context, sdk)
    } catch (e) {
      if (e instanceof RateLimitError) {
        reply = "brain's a bit overloaded right now, try again in a sec"
      } else {
        throw e
      }
    }
    context.add('assistant', reply)
    await sdk.send(sender, reply)
  }

  // ─── Watcher ─────────────────────────────────────────────────────────────
  await sdk.startWatching({
    onDirectMessage: async (msg) => {
      if (msg.isFromMe) return
      if (msg.isReaction) return
      if (!config.allowedSenders.has(msg.sender)) {
        if (config.debug) console.log(`[Watcher] ignored non-allowed sender: ${msg.sender}`)
        return
      }

      const text = msg.text?.trim() ?? ''
      if (!text) return

      // Debounce batching — collect rapid-fire messages into one story
      if (config.debounceMs > 0) {
        const existing = pendingBatches.get(msg.sender)
        if (existing) {
          clearTimeout(existing.timer)
          existing.messages.push(text)
        } else {
          pendingBatches.set(msg.sender, { messages: [text], timer: null! })
        }

        const batch = pendingBatches.get(msg.sender)!
        batch.timer = setTimeout(() => {
          pendingBatches.delete(msg.sender)
          const combined = batch.messages.join('\n')
          queue.enqueue(() => processMessage(combined, msg.sender))
        }, config.debounceMs)
      } else {
        queue.enqueue(() => processMessage(text, msg.sender))
      }
    },
    onError: (err) => {
      console.error('[Watcher] error:', err)
    },
  })
  console.log('✓ Watcher started (polling every 2s)')

  // ─── Scheduler ───────────────────────────────────────────────────────────
  const scheduler = setupScheduler(sdk, config.myNumber)
  console.log('✓ Scheduler started (8:30am daily + Sunday 7pm reflection + reminders)')

  console.log()
  console.log('🌊 Drift is live — text something!')
  console.log('   Press Ctrl+C to stop.')
  console.log()

  // ─── Graceful Shutdown ───────────────────────────────────────────────────
  async function shutdown() {
    console.log('\n🌊 Drift shutting down...')

    // Clear any pending debounce timers — process them immediately
    for (const [sender, batch] of pendingBatches) {
      clearTimeout(batch.timer)
      if (batch.messages.length > 0) {
        const combined = batch.messages.join('\n')
        await processMessage(combined, sender).catch(() => {})
      }
    }

    contextManager.persist()
    console.log('   ✓ Context saved')

    scheduler.destroy()
    console.log('   ✓ Scheduler stopped')

    try {
      db.pragma('wal_checkpoint(FULL)')
      console.log('   ✓ Database checkpointed')
    } catch {
      /* already closed */
    }

    sdk.stopWatching()
    await sdk.close()
    console.log('   ✓ SDK closed')

    console.log('\n🌊 See you next time.')
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('💥 Fatal error:', err)
  process.exit(1)
})
