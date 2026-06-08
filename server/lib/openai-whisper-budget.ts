// OpenAI Whisper API daily budget — hard $5/day ceiling.
//
// When whisper-server stalls, callers fall to transcribeViaCloud / transcribeCloud
// (OpenAI Whisper API, $0.006/min). Without a cap, a hung whisper-server during
// a long meeting could bill hundreds of dollars silently — every chunk shipped
// straight to OpenAI until someone notices.
//
// This module enforces a per-LOCAL-DAY hard cap. `assertOpenAIWhisperBudget()`
// throws BEFORE any OpenAI call if we're already over. `recordOpenAIWhisperUsage()`
// is called AFTER a successful call with the audio duration (seconds), so the
// ledger only counts billable audio (not retries that never reached the API).
//
// Cost: Whisper API is billed per second, rounded up, at $0.006/min
// = $0.0001 / second. $5 cap = 50,000 seconds = 833 min = 13.9 h of audio.
//
// State is persisted atomically to server/data/openai-whisper-budget.json.
// Reset is lazy: when a read finds a date != today's localDay(), it starts fresh.
// No setInterval, no rollover timers — midnight just means the next read returns
// a zeroed state.

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteFileSync, loadJsonOrQuarantine } from './atomic-fs.js'
import { localDay } from './local-day.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
import { dataPath } from './data-dir.js'
const BUDGET_FILE = dataPath('openai-whisper-budget.json')

/** OpenAI Whisper API pricing (2024-2025): $0.006 per minute of audio, billed to the second. */
export const USD_PER_MINUTE = 0.006
export const USD_PER_SECOND = USD_PER_MINUTE / 60

/** Daily hard cap in USD. Tunable via env (OPENAI_WHISPER_DAILY_CAP_USD) — default $5. */
export const DAILY_USD_CAP = Number(process.env.OPENAI_WHISPER_DAILY_CAP_USD ?? 5)

/** Warn threshold — logs once when we cross this fraction of the cap. */
const WARN_FRACTION = 0.8

export class OpenAIWhisperBudgetExhaustedError extends Error {
  public readonly spentTodayUsd: number
  public readonly capUsd: number
  public readonly secondsToday: number
  public readonly callsToday: number

  constructor(state: BudgetState) {
    const msg =
      `OpenAI Whisper daily budget exhausted: $${state.usdToday.toFixed(4)}/$${DAILY_USD_CAP.toFixed(2)} ` +
      `(${state.secondsToday.toFixed(0)}s of audio across ${state.callsToday} calls today). ` +
      `Cause: whisper-server is unhealthy — fix it before transcription resumes. ` +
      `Recovery: pkill -9 -f whisper-server && restart cos-glasses server (auto-restarts model).`
    super(msg)
    this.name = 'OpenAIWhisperBudgetExhaustedError'
    this.spentTodayUsd = state.usdToday
    this.capUsd = DAILY_USD_CAP
    this.secondsToday = state.secondsToday
    this.callsToday = state.callsToday
  }
}

interface BudgetState {
  /** Local-tz YYYY-MM-DD — when this doesn't equal localDay() on next read, we reset. */
  date: string
  /** Cumulative audio seconds billed today. */
  secondsToday: number
  /** Number of successful cloud calls today (diagnostics). */
  callsToday: number
  /** Derived: USD spent today. Recomputed on every write from secondsToday. */
  usdToday: number
  /** Whether we've already logged the 80% warning today (so we don't spam). */
  warnedAt80: boolean
}

function fresh(): BudgetState {
  return { date: localDay(), secondsToday: 0, callsToday: 0, usdToday: 0, warnedAt80: false }
}

function read(): BudgetState {
  if (!existsSync(BUDGET_FILE)) return fresh()
  const r = loadJsonOrQuarantine<BudgetState>(BUDGET_FILE)
  if (r.status !== 'ok') return fresh()
  if (r.data.date !== localDay()) return fresh() // new day, zero ledger
  return r.data
}

function write(state: BudgetState): void {
  try {
    atomicWriteFileSync(BUDGET_FILE, JSON.stringify(state, null, 2))
  } catch (err) {
    // Non-fatal — worst case we slightly under-count next read and over-spend a few cents.
    console.error('[openai-whisper-budget] Failed to persist budget state:', err)
  }
}

/**
 * Estimate audio duration in seconds from a raw buffer. Used BEFORE the OpenAI
 * call so we can reject over-budget calls without making them.
 *
 * Accuracy: exact for our 16 kHz / 16-bit / mono WAV (subtract 44-byte header,
 * divide by 32000 bytes/sec). For WebM/other formats (rare — the dictation path
 * uses WAV), approximates byteLength / 32000 which over-estimates = conservative
 * for billing. Never under-estimates silently.
 */
export function estimateAudioSeconds(audioBuffer: Buffer): number {
  if (audioBuffer.length < 4) return 0
  const isWav = audioBuffer.toString('ascii', 0, 4) === 'RIFF'
  const dataBytes = isWav ? Math.max(0, audioBuffer.length - 44) : audioBuffer.length
  return dataBytes / 32000 // 16 kHz × 16-bit × mono = 32000 bytes/sec
}

/**
 * Throw BEFORE making any OpenAI Whisper call if today's budget is already spent.
 * Caller must handle OpenAIWhisperBudgetExhaustedError — typical behaviour is to
 * surface a loud error to the client (500 / "cloud transcription unavailable, fix
 * whisper-server") instead of silently returning empty text.
 */
export function assertOpenAIWhisperBudget(): void {
  const state = read()
  if (state.usdToday >= DAILY_USD_CAP) {
    throw new OpenAIWhisperBudgetExhaustedError(state)
  }
}

/**
 * Record a successful cloud transcription. `audioSeconds` should be the
 * duration of the audio we sent to OpenAI (not the latency of the response).
 */
export function recordOpenAIWhisperUsage(audioSeconds: number): void {
  if (audioSeconds <= 0) return
  const state = read()
  const before = state.usdToday
  state.secondsToday += audioSeconds
  state.callsToday += 1
  state.usdToday = state.secondsToday * USD_PER_SECOND

  const warnThreshold = DAILY_USD_CAP * WARN_FRACTION
  if (before < warnThreshold && state.usdToday >= warnThreshold && !state.warnedAt80) {
    console.warn(
      `[openai-whisper-budget] WARN — $${state.usdToday.toFixed(4)}/$${DAILY_USD_CAP.toFixed(2)} ` +
      `(${((state.usdToday / DAILY_USD_CAP) * 100).toFixed(0)}%) today across ${state.callsToday} calls. ` +
      `If whisper-server is stalled, fix it now to avoid the hard cap.`,
    )
    state.warnedAt80 = true
  }

  if (state.usdToday >= DAILY_USD_CAP) {
    console.error(
      `[openai-whisper-budget] HARD CAP REACHED — $${state.usdToday.toFixed(4)}/$${DAILY_USD_CAP.toFixed(2)} today. ` +
      `All further OpenAI Whisper calls will throw until local midnight.`,
    )
  }

  write(state)
}

/** Status snapshot for diagnostics / health endpoints. */
export function getOpenAIWhisperBudgetState(): BudgetState & {
  capUsd: number
  remainingUsd: number
  percentUsed: number
} {
  const state = read()
  return {
    ...state,
    capUsd: DAILY_USD_CAP,
    remainingUsd: Math.max(0, DAILY_USD_CAP - state.usdToday),
    percentUsed: Math.round((state.usdToday / DAILY_USD_CAP) * 100),
  }
}
