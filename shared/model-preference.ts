export type ClaudeModelPreference = 'opus' | 'sonnet' | 'haiku'
// MVP server: the local Claude Code CLI is the only chat backend, so a model
// preference is always a Claude model.
export type ModelPreference = ClaudeModelPreference

export const DEFAULT_MODEL = 'opus' as const

export const MODEL_OPTIONS: ModelPreference[] = ['opus', 'sonnet', 'haiku']

const MODEL_SET = new Set<ModelPreference>(['opus', 'sonnet', 'haiku'])

export function isModelPreference(value: unknown): value is ModelPreference {
  return typeof value === 'string' && MODEL_SET.has(value as ModelPreference)
}

export function normalizeModelPreference(value: unknown): ModelPreference | undefined {
  return isModelPreference(value) ? value : undefined
}

export function isClaudeModel(model: ModelPreference): model is ClaudeModelPreference {
  return model === 'opus' || model === 'sonnet' || model === 'haiku'
}

export function modelLabel(model: ModelPreference): string {
  switch (model) {
    case 'sonnet': return 'Sonnet'
    case 'haiku': return 'Haiku'
    case 'opus':
    default:
      return 'Opus'
  }
}

export function modelShortLabel(model: ModelPreference): string {
  switch (model) {
    case 'sonnet': return 'Sonnet'
    case 'haiku': return 'Haiku'
    case 'opus':
    default:
      return 'Opus'
  }
}

export function modelButtonLabel(model: ModelPreference): string {
  switch (model) {
    case 'sonnet': return 'SNNT'
    case 'haiku': return 'HAIKU'
    case 'opus':
    default:
      return 'OPUS'
  }
}

export function modelTag(model: ModelPreference): string {
  switch (model) {
    case 'sonnet': return 'S'
    case 'haiku': return 'H'
    case 'opus':
    default:
      return 'O'
  }
}

export function modelBracketTag(model: ModelPreference): string {
  return ` [${modelTag(model)}]`
}
