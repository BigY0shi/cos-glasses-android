// Codex bridge — streaming-compatible interface to `codex exec --json`
// MVP target: local subscription-authenticated GPT-5.5 High via Codex CLI.

import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import crypto from 'node:crypto'
import { tmpPath } from './platform.js'
import { logTokenAudit } from './token-audit.js'
import { buildSystemPrompt, buildLightweightSystemPrompt } from './context-builder.js'
import {
  getHistory,
  addExchange,
  formatHistoryForPrompt,
  getOrCreateSession,
  isNewSession,
  markSessionNotified,
  getSessionRaw,
  replaceLastExchangeWithSummary,
  type PromptReference,
} from './conversation.js'
import { notifySessionStart, notifyExchange } from './telegram-notify.js'
import {
  clearCodexEngineSession,
  getCodexEngineSession,
  saveCodexEngineSession,
  type CodexEngineSession,
} from './codex-engine-sessions.js'
import {
  CODEX_HIGH_MODEL,
  CODEX_HIGH_REASONING_EFFORT,
  CODEX_MODEL_ID,
  type CodexModelPreference,
} from '../../shared/model-preference.js'
import type { CallOptions, StreamCallbacks } from './claude-bridge.js'
import {
  classifyCodexError,
  extractCodexThreadId,
  finishCodexRun,
  getCodexExecutionCwd,
  isCodexPersistenceEnabled,
  getCodexTrustMode,
  startCodexRun,
  updateCodexRun,
  type CodexRunStatus,
} from './codex-run-ledger.js'

const INACTIVITY_MS = 180_000
const WALL_MAX_MS = 900_000
const HEARTBEAT_INTERVAL_MS = 6_000

type Phase = 'context' | 'thinking' | 'generating'

const PHASE_LABELS: Record<Phase, string> = {
  context: 'Loading context...',
  thinking: 'Reasoning...',
  generating: 'Writing...',
}

// Sandbox policy for `codex exec`. This public server NEVER runs codex
// unsandboxed — that would let a remote glasses query execute arbitrary commands
// on the host. Default: read-only (safe for chat). COS_CODEX_SANDBOX=workspace-write
// permits writes within the working directory only. Full host access is
// intentionally not exposed by this server.
function codexSandboxArgs(): string[] {
  const mode = process.env.COS_CODEX_SANDBOX === 'workspace-write' ? 'workspace-write' : 'read-only'
  return ['--sandbox', mode, '--skip-git-repo-check']
}

export function buildCodexExecArgs(input: {
  codexCwd: string
  imagePaths?: string[]
  persistentCodexSession: boolean
  codexThreadId?: string
}): string[] {
  const imagePaths = input.imagePaths ?? []
  const args = ['exec']
  if (input.codexThreadId) {
    args.push(
      'resume',
      '--json',
      '--all',
      ...codexSandboxArgs(),
      '-c', `model_reasoning_effort="${CODEX_HIGH_REASONING_EFFORT}"`,
    )
    if (CODEX_MODEL_ID) args.push('--model', CODEX_MODEL_ID)
    for (const p of imagePaths) args.push('--image', p)
    args.push(input.codexThreadId, '-')
    return args
  }

  args.push(
    '--json',
    '--cd', input.codexCwd,
    ...codexSandboxArgs(),
    '-c', `model_reasoning_effort="${CODEX_HIGH_REASONING_EFFORT}"`,
  )
  if (CODEX_MODEL_ID) args.push('--model', CODEX_MODEL_ID)
  if (!input.persistentCodexSession) args.push('--ephemeral')
  for (const p of imagePaths) args.push('--image', p)
  args.push('-')
  return args
}

function buildCodexPrompt(systemPrompt: string, fullQuery: string): string {
  return [
    'SYSTEM INSTRUCTIONS',
    systemPrompt,
    '',
    'USER REQUEST',
    fullQuery,
  ].join('\n')
}

function eventText(event: any): string {
  const item = event?.item ?? event?.payload ?? event?.message ?? event

  if (typeof event?.delta === 'string') return event.delta
  if (typeof event?.text === 'string' && /message|delta|answer/i.test(String(event.type ?? ''))) return event.text
  if (typeof item?.text === 'string' && /agent_message|message|assistant/i.test(String(item.type ?? event?.type ?? ''))) return item.text

  const content = item?.content ?? event?.content
  if (Array.isArray(content)) {
    let text = ''
    for (const block of content) {
      if (typeof block === 'string') text += block
      if (typeof block?.text === 'string') text += block.text
      if (typeof block?.content === 'string') text += block.content
      if (typeof block?.output_text === 'string') text += block.output_text
    }
    return text
  }

  if (typeof item?.result === 'string' && /result|completed|answer/i.test(String(event?.type ?? ''))) return item.result
  return ''
}

function toolStatus(event: any): string | undefined {
  const type = String(event?.type ?? '')
  const item = event?.item ?? event?.payload
  const itemType = String(item?.type ?? '')
  const name = item?.name ?? item?.tool_name

  if (type === 'thread.started') return 'Starting Codex...'
  if (type === 'turn.started') return 'Reasoning...'
  if (/patch/i.test(type) || /patch/i.test(itemType)) return 'Applying patch...'
  if (/command|exec|shell/i.test(type) || /command|exec|shell/i.test(itemType)) return 'Using shell...'
  if (/tool/i.test(type) || /tool/i.test(itemType)) {
    if (typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,24}$/.test(name)) return name
    return 'Using tool...'
  }
  return undefined
}

function safeCodexUserError(message: string): string {
  const code = classifyCodexError(message)
  if (code === 'codex.cli_unavailable') return 'Codex CLI unavailable. Check server Settings.'
  if (code === 'codex.auth_error') return 'Codex auth failed. Run codex login on the Mac.'
  if (code === 'codex.timeout') return 'Codex timed out. Retry or start a new chat.'
  if (code === 'codex.permission_denied') return 'Codex permission failed. Check full-access configuration.'
  return `Codex failed (${code}). Retry or check Codex Debug.`
}

export async function callCodexStreaming(
  query: string,
  sessionId: string | undefined,
  callbacks: StreamCallbacks,
  model: CodexModelPreference = CODEX_HIGH_MODEL,
  images?: string[],
  reference?: PromptReference,
  globalMsgNum?: number,
  options?: CallOptions,
): Promise<string> {
  const sid = getOrCreateSession(sessionId)
  const history = getHistory(sid)
  const session = getSessionRaw(sid)
  const contextBreaks = session?.contextBreaks ?? []
  const historyPrompt = formatHistoryForPrompt(history, contextBreaks, reference)
  const contextPrompt = historyPrompt
  const persistentCodexSession = isCodexPersistenceEnabled()
  const codexCwd = getCodexExecutionCwd()
  const codexTrustMode = getCodexTrustMode()
  const engineSession = persistentCodexSession
    ? getCodexEngineSession({ cosSessionId: sid, model, cwd: codexCwd, trustMode: codexTrustMode })
    : null
  const startTime = Date.now()
  const run = startCodexRun({
    cosSessionId: sid,
    model,
    cwd: codexCwd,
    ephemeral: !persistentCodexSession,
    resumed: !!engineSession,
    trustMode: codexTrustMode,
    codexThreadId: engineSession?.codexThreadId,
    expiresAt: engineSession?.expiresAt,
    query,
  })
  let codexThreadId: string | undefined = engineSession?.codexThreadId
  callbacks.onStart?.(model, sid, undefined, { codexRunId: run.runId, codexThreadId })

  let phase: Phase = 'context'
  let systemPrompt: string
  try {
    if (options?.lightweight) {
      systemPrompt = buildLightweightSystemPrompt(query, contextPrompt)
    } else {
      callbacks.onToolStatus?.('Loading context...')
      systemPrompt = await buildSystemPrompt(contextPrompt)
    }
  } catch (err: any) {
    finishCodexRun(run.runId, {
      status: 'failed',
      startedAtMs: startTime,
      error: `codex-bridge: context build failed — ${err?.message ?? 'unknown error'}`,
      exitCode: null,
    })
    throw err
  }

  phase = 'thinking'
  callbacks.onToolStatus?.('Reasoning...')

  const imagePaths: string[] = []
  try {
    if (images && images.length > 0) {
      for (const img of images) {
        const id = crypto.randomUUID().slice(0, 8)
        const p = tmpPath(`cos-vision-${id}.jpg`)
        writeFileSync(p, Buffer.from(img, 'base64'))
        imagePaths.push(p)
      }
    }
  } catch (err: any) {
    for (const p of imagePaths) {
      try { unlinkSync(p) } catch { /* ignore */ }
    }
    finishCodexRun(run.runId, {
      status: 'failed',
      startedAtMs: startTime,
      error: `codex-bridge: image staging failed — ${err?.message ?? 'unknown error'}`,
      exitCode: null,
    })
    throw err
  }

  const isFirstQuery = isNewSession(sid)
  const photoPrefix = imagePaths.length === 1 ? '[Photo]' : imagePaths.length > 1 ? `[${imagePaths.length} Photos]` : ''
  const historyQuery = photoPrefix ? `${photoPrefix} ${query || 'What do you see?'}` : query
  addExchange(sid, 'user', historyQuery, globalMsgNum)

  let fullQuery: string
  if (imagePaths.length === 1) {
    fullQuery = `The user has shared a photo from their phone camera. Use the attached image, then respond to their request: ${query || 'Describe what you see in this image concisely.'}`
  } else if (imagePaths.length > 1) {
    fullQuery = `The user has shared ${imagePaths.length} photos from their phone camera. Use the attached images, then respond to their request: ${query || 'Describe what you see in these images concisely.'}`
  } else {
    fullQuery = query
  }

  const prompt = buildCodexPrompt(systemPrompt, fullQuery)
  const args = buildCodexExecArgs({
    codexCwd,
    imagePaths,
    persistentCodexSession,
    codexThreadId: engineSession?.codexThreadId,
  })

  const env = { ...process.env }
  delete env.CLAUDECODE

  const proc = spawn('codex', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd: codexCwd,
  })

  let fullText = ''
  let stderr = ''
  let buffer = ''
  let finalized = false
  let lastActivity = Date.now()
  const emittedBlocks = new Set<string>()

  function cleanupImages() {
    for (const p of imagePaths) {
      try { unlinkSync(p) } catch { /* ignore */ }
    }
  }

  function cleanup() {
    clearInterval(heartbeat)
    clearTimeout(inactivityTimer)
    clearTimeout(wallTimer)
    options?.abortSignal?.removeEventListener('abort', handleAbort)
  }

  function emitText(text: string) {
    if (!text || emittedBlocks.has(text)) return
    emittedBlocks.add(text)
    phase = 'generating'
    fullText += text
    callbacks.onChunk(text)
  }

  function finalize(text: string) {
    if (finalized) return
    finalized = true
    cleanup()
    cleanupImages()

    const totalMs = Date.now() - startTime
    logTokenAudit({
      source: options?.lightweight ? 'g2-voice' : 'g2-query',
      model,
      inputChars: systemPrompt.length + fullQuery.length + contextPrompt.length,
      outputChars: text.length,
      durationMs: totalMs,
      caller: options?.lightweight ? 'voice_query' : 'full_query',
    })
    if (persistentCodexSession && codexThreadId) {
      const saved = saveCodexEngineSession({
        cosSessionId: sid,
        model,
        codexThreadId,
        cwd: codexCwd,
        trustMode: codexTrustMode,
      })
      updateCodexRun(run.runId, { codexThreadId, expiresAt: saved.expiresAt })
    }

    finishCodexRun(run.runId, {
      status: 'completed',
      startedAtMs: startTime,
      output: text,
      exitCode: 0,
    })
    addExchange(sid, 'assistant', text, globalMsgNum)
    if (imagePaths.length > 0) {
      replaceLastExchangeWithSummary(sid, query, text, imagePaths.length)
    }

    callbacks.onDone(text, model, undefined, { codexRunId: run.runId, codexThreadId })

    if (isFirstQuery) {
      notifySessionStart(sid, query)
      markSessionNotified(sid)
    }
    notifyExchange(sid, query, text)
  }

  function finalizeError(msg: string, exitCode?: number | null, status: Exclude<CodexRunStatus, 'running'> = 'failed') {
    if (finalized) return
    finalized = true
    cleanup()
    cleanupImages()
    if (engineSession) {
      clearCodexEngineSession(sid, model)
    }
    finishCodexRun(run.runId, {
      status,
      startedAtMs: startTime,
      error: msg,
      exitCode,
    })
    callbacks.onError(safeCodexUserError(msg))
  }

  function handleAbort() {
    if (finalized) return
    proc.kill('SIGTERM')
    finalizeError('codex-bridge: client disconnected before Codex completed.', null, 'client_disconnected')
  }

  const heartbeat = setInterval(() => {
    if (finalized) return
    callbacks.onToolStatus?.(PHASE_LABELS[phase] ?? 'Processing...')
  }, HEARTBEAT_INTERVAL_MS)

  let inactivityTimer = setTimeout(() => {
    proc.kill('SIGTERM')
    const elapsed = Math.round((Date.now() - startTime) / 1000)
    finalizeError(`No output for ${INACTIVITY_MS / 1000}s (${elapsed}s total). Codex process killed.`)
  }, INACTIVITY_MS)

  function resetInactivity() {
    lastActivity = Date.now()
    clearTimeout(inactivityTimer)
    inactivityTimer = setTimeout(() => {
      proc.kill('SIGTERM')
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      finalizeError(`No output for ${INACTIVITY_MS / 1000}s (${elapsed}s total). Codex process killed.`)
    }, INACTIVITY_MS)
  }

  const wallTimer = setTimeout(() => {
    proc.kill('SIGTERM')
    if (fullText) {
      finalize(fullText)
    } else {
      finalizeError(`Wall clock limit reached (${WALL_MAX_MS / 1000}s). Codex process killed.`)
    }
  }, WALL_MAX_MS)

  if (options?.abortSignal) {
    if (options.abortSignal.aborted) {
      handleAbort()
    } else {
      options.abortSignal.addEventListener('abort', handleAbort, { once: true })
    }
  }

  function handleEvent(event: any) {
    const nextThreadId = extractCodexThreadId(event)
    if (nextThreadId && nextThreadId !== codexThreadId) {
      codexThreadId = nextThreadId
      updateCodexRun(run.runId, { codexThreadId })
    }

    const status = toolStatus(event)
    if (status) callbacks.onToolStatus?.(status)

    const text = eventText(event)
    if (text) emitText(text)

    const type = String(event?.type ?? '')
    if (type === 'turn.completed') {
      finalize(fullText)
    } else if (type === 'turn.failed' || type === 'error') {
      finalizeError(`codex-bridge: ${event?.error ?? event?.message ?? 'unknown error'}`)
    }
  }

  proc.stdout.on('data', (chunk: Buffer) => {
    resetInactivity()
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        handleEvent(JSON.parse(trimmed))
      } catch {
        // Ignore non-JSON status lines from older CLI builds.
      }
    }
  })

  proc.stderr.on('data', (chunk: Buffer) => {
    resetInactivity()
    stderr += chunk.toString()
  })

  proc.on('close', (code) => {
    if (buffer.trim()) {
      try { handleEvent(JSON.parse(buffer.trim())) } catch { /* ignore */ }
    }
    if (finalized) return
    if (code !== 0) {
      finalizeError(`codex-bridge: exit ${code} — ${stderr.trim().slice(0, 240)}`, code)
    } else if (fullText) {
      finalize(fullText)
    } else {
      finalizeError('codex-bridge: Codex completed without a response.')
    }
  })

  proc.on('error', (err) => {
    finalizeError(`codex-bridge: ${err.message}`)
  })

  proc.stdin.write(prompt)
  proc.stdin.end()

  return sid
}
