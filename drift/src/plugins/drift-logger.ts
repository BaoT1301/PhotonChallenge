import { definePlugin } from '@photon-ai/imessage-kit'

export const driftLogger = definePlugin({
  name: 'drift-logger',
  version: '1.0.0',

  onInit: async () => {
    console.log('[Plugin:drift-logger] initialized')
  },

  onNewMessage: async (msg) => {
    const direction = msg.isFromMe ? '↑' : '↓'
    const preview = msg.text?.slice(0, 60) ?? '[no text]'
    const reaction = msg.isReaction ? ` (reaction: ${msg.reactionType})` : ''
    const group = msg.isGroupChat ? ' [group]' : ''
    console.log(`[MSG] ${direction} ${msg.sender}${group}: "${preview}"${reaction}`)
  },

  onAfterSend: async (to, result) => {
    console.log(`[SENT] → ${to} at ${result.sentAt.toISOString()}`)
  },

  onError: async (error, context) => {
    console.error(`[ERROR] [${context ?? 'unknown'}] ${error.message}`)
  },

  onDestroy: async () => {
    console.log('[Plugin:drift-logger] destroyed')
  },
})
