// Audio enhancement via ffmpeg — noise reduction + loudness normalization.
// Extracted so both batch (post-meeting) and one-shot (message query HQ) paths
// can use the same filter chain.
//
// Filter chain:
//   highpass=f=80  — kills low-freq rumble (HVAC, body noise, table thumps)
//   afftdn=nt=w    — FFT-based denoiser (white noise, fan hum)
//   loudnorm       — EBU R128 loudness normalization (fixes quiet speakers)
//
// Graceful: returns the original buffer if ffmpeg is missing, fails, or times out.
// Callers should never crash a user request because enhancement couldn't run.

import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const FFMPEG_TIMEOUT_MS = 30_000
const FILTER_CHAIN = 'highpass=f=80,afftdn=nt=w,loudnorm=I=-16:LRA=11:TP=-1.5'

/**
 * Enhance raw audio (WAV/webm/etc) and return a 16kHz mono WAV buffer suitable
 * for whisper-cli or whisper-server. Input format is detected by ffmpeg — no
 * need to pre-convert.
 *
 * Returns the ORIGINAL buffer unchanged on any failure. Logs the reason.
 */
export async function enhanceAudio(audioBuffer: Buffer): Promise<Buffer> {
  const id = randomUUID().slice(0, 8)
  const inputPath = join('/tmp', `cos-enhance-in-${id}`)
  const outputPath = join('/tmp', `cos-enhance-out-${id}.wav`)

  try {
    writeFileSync(inputPath, audioBuffer)

    const enhanced = await new Promise<Buffer>((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-i', inputPath,
        '-af', FILTER_CHAIN,
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        '-y',
        outputPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })

      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM')
        reject(new Error(`ffmpeg timeout (${FFMPEG_TIMEOUT_MS / 1000}s)`))
      }, FFMPEG_TIMEOUT_MS)

      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code !== 0) {
          reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(-200)}`))
          return
        }
        if (!existsSync(outputPath)) {
          reject(new Error('ffmpeg produced no output file'))
          return
        }
        try {
          resolve(readFileSync(outputPath))
        } catch (readErr: unknown) {
          reject(readErr instanceof Error ? readErr : new Error(String(readErr)))
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    return enhanced
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[audio-enhance] ffmpeg failed, returning original buffer: ${msg}`)
    return audioBuffer
  } finally {
    try { unlinkSync(inputPath) } catch { /* ignore */ }
    try { unlinkSync(outputPath) } catch { /* ignore */ }
  }
}
