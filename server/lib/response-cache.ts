// Predictive response cache — instant responses for common G2 queries
// Bypasses Claude CLI entirely for pattern-matched queries using cached COS context.
// TTFB: ~10ms vs ~1-3s through Claude.

import { getCachedContextInstant } from './context-builder.js'
import { getOwnerName, loadProfileField } from './profile.js'

interface CacheResult {
  text: string
  pattern: string
}

// Narrow match list — one-liners only. Over-matching degrades experience.
const PATTERNS: Array<{ regex: RegExp; name: string; handler: (query: string) => string | null }> = [
  {
    regex: /^(what('?s| is) (the )?)?time\??$|^what time is it\??$/i,
    name: 'time',
    handler: () => {
      const now = new Date()
      return now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    },
  },
  {
    regex: /^what('?s| is) (the )?(date|day)( today)?\??$|^what day is it\??$/i,
    name: 'date',
    handler: () => {
      const now = new Date()
      return now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    },
  },
  {
    regex: /^(what('?s| is) my )?(next meeting|next call)\??$/i,
    name: 'next_meeting',
    handler: () => {
      const ctx = getCachedContextInstant()
      if (!ctx || ctx.includes('unavailable')) return null
      const nextMatch = ctx.match(/NEXT:\s*(.+)/i)
      if (!nextMatch) {
        if (ctx.includes('No more meetings')) return 'No more meetings today.'
        return null
      }
      return nextMatch[1].trim()
    },
  },
  {
    regex: /^(what('?s| is) my )?(schedule|calendar|meetings)( today)?\??$/i,
    name: 'schedule',
    handler: () => {
      const ctx = getCachedContextInstant()
      if (!ctx || ctx.includes('unavailable')) return null
      // Extract the CALENDAR section
      const calMatch = ctx.match(/CALENDAR:\n([\s\S]*?)(?:\n\n|$)/)
      if (!calMatch) return null
      return calMatch[1].trim()
    },
  },
  {
    regex: /^(how many )?(open )?tasks?\??$/i,
    name: 'task_count',
    handler: () => {
      const ctx = getCachedContextInstant()
      if (!ctx || ctx.includes('unavailable')) return null
      const taskMatch = ctx.match(/(\d+) open tasks? total/)
      if (!taskMatch) return null
      return `${taskMatch[1]} open tasks.`
    },
  },
  {
    regex: /^(who am i|who is \w+|tell me about myself)\??$/i,
    name: 'who_am_i',
    handler: () => {
      const name = getOwnerName()
      const context = loadProfileField('system_prompt_context', '')
      if (context) return `You're ${name}. ${context}`
      return `You're ${name}. Configure .cos-profile.json for more context.`
    },
  },
  {
    regex: /^(hey|hi|hello|yo|sup|what's up|hey even)[\s!.]*$/i,
    name: 'greeting',
    handler: () => {
      const name = getOwnerName().split(' ')[0]  // First name only
      const hour = new Date().getHours()
      if (hour < 12) return `Good morning, ${name}.`
      if (hour < 17) return `Good afternoon, ${name}.`
      return `Good evening, ${name}.`
    },
  },
  {
    regex: /^(thanks|thank you|thx|ty|appreciate it|got it|ok|okay|cool|great|perfect)[\s!.]*$/i,
    name: 'acknowledgment',
    handler: () => {
      return "Anytime."
    },
  },
  {
    regex: /^what('?s| is) (\d+)\s*[\+\-\*x×]\s*(\d+)\??$/i,
    name: 'basic_math',
    handler: (query: string) => {
      const m = query.match(/(\d+)\s*([\+\-\*x×])\s*(\d+)/i)
      if (!m) return null
      const a = parseInt(m[1], 10)
      const b = parseInt(m[3], 10)
      const op = m[2]
      let result: number
      switch (op) {
        case '+': result = a + b; break
        case '-': result = a - b; break
        case '*': case 'x': case '×': result = a * b; break
        default: return null
      }
      return `${a} ${op === 'x' || op === '×' ? '×' : op} ${b} = ${result}`
    },
  },
]

/**
 * Try to answer a query instantly from cached context.
 * Returns null if the query doesn't match any cached pattern.
 */
export function tryInstantResponse(query: string): CacheResult | null {
  const q = query.trim()
  // Skip long queries — they're unlikely to be simple lookups
  if (q.length > 60) return null

  for (const { regex, name, handler } of PATTERNS) {
    if (regex.test(q)) {
      const text = handler(q)
      if (text) {
        return { text, pattern: name }
      }
      // Pattern matched but handler returned null (e.g., cache stale) — fall through to Claude
      return null
    }
  }

  return null
}
