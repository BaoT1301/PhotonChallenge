import { IMessageSDK } from '@photon-ai/imessage-kit'
import type { Message } from '@photon-ai/imessage-kit'
import { config } from './config.js'
import { MessageQueue } from './queue.js'
import { ContextManager } from './context.js'
import { handleMessage } from './router.js'
import { initDB, getDB, getMemoryCount, getPendingFailedMessages, incrementFailedRetry, deleteFailedMessage } from './memory/db.js'
import { warmupEmbeddings, getEmbedding } from './memory/embeddings.js'
import { storeMemory } from './handlers/store.js'
import { analyzeImage } from './handlers/image.js'
import { transcribeAudio, isAudioFile } from './handlers/voice.js'
import { setupScheduler } from './scheduler.js'
import { driftLogger } from './plugins/drift-logger.js'
import { RateLimitError } from './retry.js'

// ─── Per-sender debounce batching ────────────────────────────────────────────
interface Batch {
  messages: string[]
  timer: ReturnType<typeof setTimeout>
}
const pendingBatches = new Map<string, Batch>()

// ─── Onboarding ───────────────────────────────────────────────────────────────
const ONBOARDING_MSG = `hey! i'm drift — your personal memory companion 🌊

just text me what's happening in your life and i'll remember it all. ask me anything later and i'll dig it up.

you can also:
• "remind me to [x] on [day]" — i'll ping you
• "what did i say about [x]?" — search your memories
• "research: [topic]" — deep dive with a full report
• "who is [name]?" — profile of anyone you've mentioned
• "my weekly review" — Sunday reflection
• "habits" — track your streaks
• "stats" — see your memory count
• send a photo — i'll analyze it
• send a voice memo — i'll transcribe it

let's go — what's on your mind?`

// ─── Startup: retry failed messages ──────────────────────────────────────────
async function retryFailedMessages(): Promise<void> {
  const failed = getPendingFailedMessages(3)
  if (failed.length === 0) return

  console.log(`⏳ Retrying ${failed.length} failed message(s) from previous run...`)
  let recovered = 0

  for (const msg of failed) {
    try {
      const embedding = await getEmbedding(msg.raw_text)
      getDB()
        .prepare(`INSERT INTO memories (raw_text, embedding, sender, tags, sentiment) VALUES (?, ?, ?, ?, 0)`)
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

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🌊 Drift starting up...')
  console.log(`   Phone:    ${config.myNumber}`)
  console.log(`   Senders:  ${[...config.allowedSenders].join(', ')}`)
  console.log(`   Calendar: ${config.calendarEnabled ? '✓ connected' : '✗ not configured'}`)
  console.log(`   Search:   ${config.searchEnabled ? '✓ enabled' : '✗ no API key'}`)
  console.log(`   Voice:    ${config.voiceEnabled ? '✓ enabled' : '✗ no OpenAI key'}`)
  console.log(`   Debounce: ${config.debounceMs > 0 ? `${config.debounceMs / 1000}s` : 'disabled'}`)
  console.log(`   Debug:    ${config.debug}`)
  console.log()

  const db = initDB()
  console.log('✓ Database ready (WAL mode)')

  await warmupEmbeddings()
  await retryFailedMessages()

  const plugins = config.debug ? [driftLogger] : []
  const sdk = new IMessageSDK({
    debug: config.debug,
    watcher: { pollInterval: 2000, excludeOwnMessages: true },
    plugins,
  })
  console.log('✓ SDK initialized')

  const contextManager = ContextManager.restore()
  console.log(`✓ Contexts restored (${contextManager.size} senders)`)

  const queue = new MessageQueue()

  // ─── Core message processor ───────────────────────────────────────────────
  async function processMessage(msg: Message): Promise<void> {
    const sender = msg.sender
    const context = contextManager.get(sender)
    const text = msg.text?.trim() ?? ''

    // First-ever message → send onboarding
    const isFirstMessage = getMemoryCount(sender) === 0 && context.length === 0
    if (isFirstMessage) {
      await sdk.send(sender, ONBOARDING_MSG)
    }

    // ── Image attachments ───────────────────────────────────────────────────
    const imageAttachments = msg.attachments.filter((a) => a.isImage)
    if (imageAttachments.length > 0) {
      const imagePaths = imageAttachments.map((a) => a.path)
      const result = await analyzeImage(imagePaths, text, context)

      if (result.memoryText) {
        // Store image analysis as a memory silently
        context.add('user', result.memoryText)
        await storeMemory(result.memoryText, sender, context)
      }

      context.add('assistant', result.reply)
      await sdk.send(sender, result.reply)
      return
    }

    // ── Audio attachments (voice memos) ─────────────────────────────────────
    const audioAttachments = msg.attachments.filter(
      (a) => isAudioFile(a.mimeType, a.filename)
    )
    if (audioAttachments.length > 0) {
      const audioPath = audioAttachments[0]!.path
      const transcript = await transcribeAudio(audioPath)

      if (transcript === '__NO_FFMPEG__') {
        await sdk.send(sender, "got a voice memo but need ffmpeg to transcribe it — run `brew install ffmpeg` then restart drift")
        return
      }

      if (!transcript) {
        await sdk.send(sender, "got the voice memo but couldn't transcribe it — try again?")
        return
      }

      // Treat transcript as regular text message
      await sdk.send(sender, `🎙️ transcribed: "${transcript.slice(0, 80)}${transcript.length > 80 ? '...' : ''}"`)
      context.add('user', transcript)

      let reply: string
      try {
        reply = await handleMessage(transcript, sender, context, sdk)
      } catch (e) {
        reply = e instanceof RateLimitError
          ? "brain's a bit overloaded right now, try again in a sec"
          : "something went wrong processing that"
      }

      context.add('assistant', reply)
      await sdk.send(sender, reply)
      return
    }

    // ── Text message ─────────────────────────────────────────────────────────
    if (!text) return

    context.add('user', text)

    let reply: string
    try {
      reply = await handleMessage(text, sender, context, sdk)
    } catch (e) {
      reply = e instanceof RateLimitError
        ? "brain's a bit overloaded right now, try again in a sec"
        : "something went wrong, try again"
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

      const hasAttachments = msg.attachments.length > 0
      const text = msg.text?.trim() ?? ''

      // Attachments bypass debounce — process immediately
      if (hasAttachments) {
        queue.enqueue(() => processMessage(msg))
        return
      }

      if (!text) return

      // Debounce text messages — batch rapid-fire messages into one story
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
          // Create a synthetic message object with the combined text
          const syntheticMsg: Message = { ...msg, text: combined }
          queue.enqueue(() => processMessage(syntheticMsg))
        }, config.debounceMs)
      } else {
        queue.enqueue(() => processMessage(msg))
      }
    },
    onError: (err) => console.error('[Watcher] error:', err),
  })
  console.log('✓ Watcher started (polling every 2s)')

  const scheduler = setupScheduler(sdk, config.myNumber)
  console.log('✓ Scheduler started (8:30am briefing · Sunday reflection · reminders · mood check-in)')

  console.log()
  console.log('🌊 Drift is live — text something!')
  console.log('   Press Ctrl+C to stop.')
  console.log()

  // ─── Graceful shutdown ────────────────────────────────────────────────────
  async function shutdown() {
    console.log('\n🌊 Drift shutting down...')

    // Flush pending debounce batches
    for (const [sender, batch] of pendingBatches) {
      clearTimeout(batch.timer)
      if (batch.messages.length > 0) {
        const combined = batch.messages.join('\n')
        const context = contextManager.get(sender)
        context.add('user', combined)
        await storeMemory(combined, sender, context).catch(() => {})
      }
    }

    contextManager.persist()
    console.log('   ✓ Context saved')

    scheduler.destroy()
    console.log('   ✓ Scheduler stopped')

    try {
      db.pragma('wal_checkpoint(FULL)')
      console.log('   ✓ Database checkpointed')
    } catch { /* already closed */ }

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
