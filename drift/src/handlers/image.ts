import fs from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { ConversationContext } from '../context.js'
import { withRetry } from '../retry.js'
import { config } from '../config.js'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

export interface ImageAnalysisResult {
  reply: string
  /** Text to store as memory — null if image has no storable content */
  memoryText: string | null
}

/**
 * Analyzes one or more image attachments using Claude Vision.
 * Returns a reply + optional memory text extracted from the image.
 */
export async function analyzeImage(
  imagePaths: string[],
  userText: string,
  context: ConversationContext
): Promise<ImageAnalysisResult> {
  // Build image content blocks
  const imageBlocks: Anthropic.ImageBlockParam[] = []

  for (const imgPath of imagePaths) {
    if (!fs.existsSync(imgPath)) continue
    try {
      const data = fs.readFileSync(imgPath)
      const base64 = data.toString('base64')
      const mimeType = getMimeType(imgPath)
      imageBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: base64 },
      })
    } catch (e) {
      console.error(`[Image] failed to read ${imgPath}:`, e)
    }
  }

  if (imageBlocks.length === 0) {
    return { reply: "got your image but couldn't read it — file might be missing", memoryText: null }
  }

  const priorMessages = context.toClaudeMessages()

  // Build multimodal messages array — prior context as text, current message with images
  const apiMessages: Anthropic.MessageParam[] = [
    ...priorMessages,
    {
      role: 'user',
      content: [
        ...imageBlocks,
        {
          type: 'text' as const,
          text: userText.trim() || 'what do you see in this image?',
        },
      ],
    },
  ]

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: `You are Drift — a personal memory companion. The user just sent you an image.

Analyze what's in it and respond naturally in iMessage style. Then decide: does this image contain useful information worth remembering? (whiteboard notes, screenshots, receipts, text, plans, etc.)

Always respond with JSON in this exact shape:
{
  "reply": "your casual iMessage-style response about the image",
  "memory_text": "text to store as memory, or null if nothing worth saving"
}

For memory_text: extract the actual useful content. For a whiteboard, transcribe it. For a receipt, note what was spent. For a meme, null. For a screenshot of something important, summarize it.`,
      messages: apiMessages,
    })
  )

  const raw = extractText(response)

  try {
    // Parse the JSON response
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('no JSON found')
    const parsed = JSON.parse(jsonMatch[0]) as { reply: string; memory_text: string | null }
    return {
      reply: parsed.reply || "interesting image!",
      memoryText: parsed.memory_text || null,
    }
  } catch {
    // Fallback: use raw text as reply, no memory
    return { reply: raw || "got the image!", memoryText: null }
  }
}

function getMimeType(filePath: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  const ext = filePath.toLowerCase().split('.').pop()
  switch (ext) {
    case 'png': return 'image/png'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    default: return 'image/jpeg'
  }
}

function extractText(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === 'text')
  return block?.type === 'text' ? block.text : ''
}
