// Daily LLM call budget for archive summary generation.
// `claude -p` calls count against the user's Claude plan allocation. A boot
// after a long offline period could trigger N × (chats + 1) Sonnet calls via
// `runDailyArchiveMirror` — easily hundreds in one burst. This cap (checked
// before EVERY claude -p call from archive.ts) forces the system to degrade
// to string-fallback summaries once the daily budget is spent.
//
// You can raise the cap or clear the counter manually if needed.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localDay } from './local-day.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
import { dataPath } from './data-dir.js'
const BUDGET_FILE = dataPath('archive-budget.json')

/** Max claude -p calls per local day across all archive summary generation. */
export const MAX_DAILY_ARCHIVE_LLM_CALLS = 30

interface BudgetState {
  date: string  // local YYYY-MM-DD
  calls: number
}

function readBudget(): BudgetState {
  const today = localDay()
  if (!existsSync(BUDGET_FILE)) return { date: today, calls: 0 }
  try {
    const raw = readFileSync(BUDGET_FILE, 'utf-8')
    const data = JSON.parse(raw) as BudgetState
    if (data.date !== today) return { date: today, calls: 0 } // new day, reset
    return data
  } catch {
    return { date: today, calls: 0 }
  }
}

function writeBudget(state: BudgetState): void {
  try {
    writeFileSync(BUDGET_FILE, JSON.stringify(state))
  } catch {
    /* non-fatal — worst case we might double-count next read */
  }
}

/**
 * Attempt to consume one LLM call from today's budget.
 * Returns true if the call is allowed and budget was decremented.
 * Returns false if budget is exhausted — caller must use a non-LLM fallback.
 */
export function consumeArchiveLLMBudget(): boolean {
  const state = readBudget()
  if (state.calls >= MAX_DAILY_ARCHIVE_LLM_CALLS) return false
  state.calls++
  writeBudget(state)
  return true
}

/** For diagnostics / dashboards. */
export function getArchiveLLMBudgetState(): BudgetState & { max: number; remaining: number } {
  const state = readBudget()
  return { ...state, max: MAX_DAILY_ARCHIVE_LLM_CALLS, remaining: Math.max(0, MAX_DAILY_ARCHIVE_LLM_CALLS - state.calls) }
}
