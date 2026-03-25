/** Thrown when all retries are exhausted on a 429 rate limit */
export class RateLimitError extends Error {
  constructor() {
    super('Rate limit exceeded after all retries')
    this.name = 'RateLimitError'
  }
}

/**
 * Exponential backoff with jitter.
 * Skips retry on 4xx client errors except 429 (rate limit).
 * Throws RateLimitError if all retries are exhausted on a 429.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> {
  let lastStatus: number | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status
      lastStatus = status
      // Don't retry on client errors (except 429 rate limit)
      if (status && status >= 400 && status < 500 && status !== 429) throw e
      if (attempt === maxRetries) {
        if (lastStatus === 429) throw new RateLimitError()
        throw e
      }

      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500
      console.warn(`[Retry] attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw new Error('unreachable')
}
