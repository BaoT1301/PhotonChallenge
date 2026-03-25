import Anthropic from '@anthropic-ai/sdk'
import { ConversationContext } from '../context.js'
import { withRetry } from '../retry.js'
import { config } from '../config.js'
import { getAgentState, setAgentState } from '../memory/db.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

interface PlaceResult {
  name: string
  rating?: number
  user_ratings_total?: number
  formatted_address: string
  price_level?: number
  opening_hours?: { open_now?: boolean }
}

interface DirectionsStep {
  html_instructions: string
  distance: { text: string }
}

interface DirectionsLeg {
  duration: { text: string }
  distance: { text: string }
  start_address: string
  end_address: string
  steps: DirectionsStep[]
}

// ─── Save home/work location shortcut ─────────────────────────────────────────
// Called from the maps handler when user says "my home is X" or "save my location"
export function trySaveLocation(text: string, sender: string): string | null {
  const t = text.toLowerCase()

  const homeMatch = t.match(/(?:my (?:home|house|apartment|place) is(?: at)?|i live at)\s+(.+)/i)
  if (homeMatch) {
    const loc = homeMatch[1]!.trim()
    setAgentState(`home_location_${sender}`, loc)
    return `got it — saved "${loc}" as your home 🏠`
  }

  const workMatch = t.match(/(?:my (?:office|work|job) is(?: at)?|i work at)\s+(.+)/i)
  if (workMatch) {
    const loc = workMatch[1]!.trim()
    setAgentState(`work_location_${sender}`, loc)
    return `saved "${loc}" as your work 💼`
  }

  return null
}

// ─── Main handler ──────────────────────────────────────────────────────────────
export async function mapsQuery(
  text: string,
  sender: string,
  context: ConversationContext
): Promise<string> {
  if (!config.googleMapsApiKey) {
    return "maps isn't set up yet — add a GOOGLE_MAPS_API_KEY to enable recommendations and directions"
  }

  // Check if this is a location save command first
  const saveResult = trySaveLocation(text, sender)
  if (saveResult) return saveResult

  // Parse intent with Claude Haiku
  const parseRes = await withRetry(() =>
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `Extract location query details. Reply with JSON only, no markdown fences.

{
  "type": "recommend" or "directions",
  "query": "natural language search like 'ramen near Pike Place Market Seattle' — include location in the query if known",
  "origin": "starting point for directions (null if unknown)",
  "destination": "destination for directions (null if not applicable)",
  "mode": "driving" or "walking" or "transit" or "bicycling",
  "vague_location": true if location is just 'near me', 'nearby', 'here' with no real address
}

Default mode to driving unless user asks for walking/transit/bike.`,
      messages: [
        ...context.toClaudeMessages(),
        { role: 'user', content: text },
      ],
    })
  )

  const raw = parseRes.content.find((b) => b.type === 'text')?.type === 'text'
    ? (parseRes.content.find((b) => b.type === 'text') as { type: 'text'; text: string }).text
    : '{}'

  let parsed: {
    type: 'recommend' | 'directions'
    query?: string
    origin?: string | null
    destination?: string | null
    mode?: string
    vague_location?: boolean
  } = { type: 'recommend', vague_location: true }

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
  } catch { /* keep default */ }

  // Resolve vague "near me" using stored home location
  if (parsed.vague_location) {
    const home = getAgentState(`home_location_${sender}`)
    if (home) {
      if (parsed.type === 'recommend' && parsed.query) {
        parsed.query = `${parsed.query} near ${home}`
        parsed.vague_location = false
      } else if (parsed.type === 'directions' && !parsed.origin) {
        parsed.origin = home
        parsed.vague_location = false
      }
    }

    if (parsed.vague_location) {
      return "where are you? drop a neighborhood, address, or city and i'll find spots 📍\n\n(you can also say \"my home is [address]\" and i'll remember it)"
    }
  }

  if (parsed.type === 'directions') {
    if (!parsed.destination) {
      return "where are you trying to get to? give me a destination and i'll get directions"
    }
    const origin = parsed.origin || getAgentState(`home_location_${sender}`) || ''
    if (!origin) {
      return "where are you starting from? give me an origin address or say \"my home is [address]\" to save it"
    }
    return getDirections(origin, parsed.destination, parsed.mode || 'driving')
  }

  return getPlaceRecommendations(parsed.query || text)
}

// ─── Places Text Search ────────────────────────────────────────────────────────
async function getPlaceRecommendations(query: string): Promise<string> {
  const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json')
  url.searchParams.set('query', query)
  url.searchParams.set('key', config.googleMapsApiKey!)

  const res = await fetch(url.toString())
  const data = await res.json() as { status: string; results: PlaceResult[] }

  if (data.status !== 'OK' || !data.results.length) {
    return "couldn't find anything for that — try adding a city or neighborhood to narrow it down"
  }

  const top = data.results.slice(0, 4)
  const lines: string[] = ['here\'s what i found 📍\n']

  for (const place of top) {
    const rating = place.rating ? `⭐ ${place.rating}` : ''
    const reviews = place.user_ratings_total ? `(${place.user_ratings_total.toLocaleString()})` : ''
    const price = place.price_level ? '$'.repeat(place.price_level) : ''
    const openNow = place.opening_hours?.open_now
    const status = openNow === true ? '· open now' : openNow === false ? '· closed' : ''
    const address = place.formatted_address.split(',').slice(0, 2).join(',').trim()

    const header = [place.name, price].filter(Boolean).join(' ')
    const meta = [rating, reviews, status].filter(Boolean).join(' ')

    lines.push(header)
    if (meta) lines.push(meta)
    lines.push(address)
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

// ─── Directions API ────────────────────────────────────────────────────────────
async function getDirections(origin: string, destination: string, mode: string): Promise<string> {
  const url = new URL('https://maps.googleapis.com/maps/api/directions/json')
  url.searchParams.set('origin', origin)
  url.searchParams.set('destination', destination)
  url.searchParams.set('mode', mode)
  url.searchParams.set('departure_time', 'now')  // enables traffic data for driving
  url.searchParams.set('key', config.googleMapsApiKey!)

  const res = await fetch(url.toString())
  const data = await res.json() as {
    status: string
    routes: Array<{ legs: DirectionsLeg[]; summary: string }>
  }

  if (data.status !== 'OK' || !data.routes.length) {
    return "couldn't get directions — double-check the addresses and try again?"
  }

  const route = data.routes[0]!
  const leg = route.legs[0]!

  const modeEmoji: Record<string, string> = {
    driving: '🚗', walking: '🚶', transit: '🚌', bicycling: '🚴',
  }
  const emoji = modeEmoji[mode] || '🗺️'

  const from = leg.start_address.split(',').slice(0, 2).join(',').trim()
  const to = leg.end_address.split(',').slice(0, 2).join(',').trim()
  const via = route.summary ? ` via ${route.summary}` : ''

  const lines: string[] = [
    `${emoji} ${from} → ${to}`,
    `${leg.distance.text} · ${leg.duration.text}${via}`,
    '',
  ]

  // Show up to 5 steps, strip HTML tags
  const steps = leg.steps.slice(0, 5)
  for (let i = 0; i < steps.length; i++) {
    const instruction = steps[i]!.html_instructions.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')
    lines.push(`${i + 1}. ${instruction} (${steps[i]!.distance.text})`)
  }

  if (leg.steps.length > 5) {
    lines.push(`… ${leg.steps.length - 5} more steps`)
  }

  return lines.join('\n')
}
