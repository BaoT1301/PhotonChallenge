import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import OpenAI from 'openai'
import { config } from '../config.js'

/**
 * Transcribes an audio attachment using OpenAI Whisper.
 * iMessage voice memos arrive as .caf files — we convert to .m4a first via ffmpeg.
 * Returns the transcript string, or null on failure.
 */
export async function transcribeAudio(audioPath: string): Promise<string | null> {
  if (!config.voiceEnabled) {
    return null
  }

  if (!fs.existsSync(audioPath)) {
    console.error('[Voice] audio file not found:', audioPath)
    return null
  }

  const ext = path.extname(audioPath).toLowerCase()
  let fileToTranscribe = audioPath

  // .caf files need converting — iMessage stores voice memos in Core Audio Format
  if (ext === '.caf') {
    const converted = audioPath.replace(/\.caf$/i, '_converted.m4a')
    try {
      execSync(`ffmpeg -y -i "${audioPath}" -c:a aac -b:a 128k "${converted}" 2>/dev/null`, {
        timeout: 30000,
      })
      fileToTranscribe = converted
    } catch {
      // ffmpeg not installed or failed — surface a helpful message
      console.warn('[Voice] ffmpeg not available for .caf conversion')
      return '__NO_FFMPEG__'
    }
  }

  try {
    const openai = new OpenAI({ apiKey: config.openaiApiKey })
    const transcript = await openai.audio.transcriptions.create({
      file: fs.createReadStream(fileToTranscribe),
      model: 'whisper-1',
      language: 'en',
    })

    // Cleanup converted file
    if (fileToTranscribe !== audioPath && fs.existsSync(fileToTranscribe)) {
      fs.unlinkSync(fileToTranscribe)
    }

    return transcript.text.trim() || null
  } catch (e) {
    console.error('[Voice] Whisper transcription failed:', e)
    return null
  }
}

export function isAudioFile(mimeType: string, filename: string): boolean {
  const audioMimes = ['audio/x-caf', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/m4a']
  const audioExts = ['.caf', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus']
  const ext = path.extname(filename).toLowerCase()
  return audioMimes.includes(mimeType) || audioExts.includes(ext)
}
