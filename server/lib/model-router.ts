import { callClaudeStreaming, type CallOptions, type StreamCallbacks } from './claude-bridge.js'
import {
  getOrCreateSession,
  getSessionModel,
  setSessionModel,
  type ModelPreference,
  type PromptReference,
} from './conversation.js'
import { DEFAULT_MODEL, isClaudeModel, normalizeModelPreference } from '../../shared/model-preference.js'

// MVP server: the local Claude Code CLI is the only chat backend. Any unknown
// model preference is clamped to the Claude default so chat always works.
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
  const requested = normalizeModelPreference(model) ?? sessionModel ?? DEFAULT_MODEL
  const resolvedModel = isClaudeModel(requested) ? requested : DEFAULT_MODEL

  setSessionModel(sid, resolvedModel)

  return callClaudeStreaming(query, sid, callbacks, resolvedModel, images, reference, globalMsgNum, options)
}
