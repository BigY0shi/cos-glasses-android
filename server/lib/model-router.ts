import { callClaudeStreaming, type CallOptions, type StreamCallbacks } from './claude-bridge.js'
import { callCodexStreaming } from './codex-bridge.js'
import {
  getOrCreateSession,
  getSessionModel,
  setSessionModel,
  type ModelPreference,
  type PromptReference,
} from './conversation.js'
import { DEFAULT_MODEL, isCodexModel, isClaudeModel, normalizeModelPreference } from '../../shared/model-preference.js'

// Chat routes to the user's local Claude Code CLI (opus/sonnet/haiku) or the
// Codex CLI (codex-high). Any unknown preference falls back to the Claude default
// so chat always works on a stock install.
export async function callModelStreaming(
  query: string,
  sessionId: string | undefined,
  callbacks: StreamCallbacks,
  model?: ModelPreference,
  images?: string[],
  reference?: PromptReference,
  globalMsgNum?: number,
  options?: CallOptions,
): Promise<string> {
  const sid = getOrCreateSession(sessionId)
  const sessionModel = getSessionModel(sid)
  const resolvedModel = normalizeModelPreference(model) ?? sessionModel ?? DEFAULT_MODEL

  setSessionModel(sid, resolvedModel)

  if (isCodexModel(resolvedModel)) {
    return callCodexStreaming(query, sid, callbacks, resolvedModel, images, reference, globalMsgNum, options)
  }
  if (isClaudeModel(resolvedModel)) {
    return callClaudeStreaming(query, sid, callbacks, resolvedModel, images, reference, globalMsgNum, options)
  }
  return callClaudeStreaming(query, sid, callbacks, DEFAULT_MODEL, images, reference, globalMsgNum, options)
}
