import 'dotenv/config'

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) {
    console.error(`✗ Missing required env var: ${name}`)
    process.exit(1)
  }
  return val
}

function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined
}

export const config = {
  myNumber: requireEnv('MY_NUMBER'),
  anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
  debug: process.env.DEBUG === 'true',

  // Security: only respond to these senders
  allowedSenders: new Set(
    (process.env.ALLOWED_SENDERS || process.env.MY_NUMBER!)
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean)
  ),

  // Conversation context tuning
  contextWindowMinutes: parseInt(process.env.CONTEXT_WINDOW_MIN || '30', 10),
  contextMaxTurns: parseInt(process.env.CONTEXT_MAX_TURNS || '10', 10),

  // Multi-message debounce batching window (ms). 0 = disabled.
  debounceMs: parseInt(process.env.DEBOUNCE_MS || '45000', 10),

  // Brave Search — optional
  braveApiKey: optionalEnv('BRAVE_API_KEY'),

  // OpenAI — optional, used for Whisper voice transcription
  openaiApiKey: optionalEnv('OPENAI_API_KEY'),

  // Google Calendar — optional
  google: {
    clientId: optionalEnv('GOOGLE_CLIENT_ID'),
    clientSecret: optionalEnv('GOOGLE_CLIENT_SECRET'),
    refreshToken: optionalEnv('GOOGLE_REFRESH_TOKEN'),
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
  },

  get calendarEnabled(): boolean {
    return !!(this.google.clientId && this.google.clientSecret && this.google.refreshToken)
  },

  get searchEnabled(): boolean {
    return !!this.braveApiKey
  },

  get voiceEnabled(): boolean {
    return !!this.openaiApiKey
  },
} as const
