// Reusable circuit breaker for `claude -p` callers. After `maxFailures`
// consecutive failures the breaker OPENS for `cooldownMs`, then HALF-OPENS
// (allows one trial call); a success CLOSES it. Mirrors the inline breaker in
// routes/meeting.ts:38-71, but as a standalone instance so independent callers
// (e.g. the outbound-dictation auto-clean) keep SEPARATE failure accounting —
// a meeting-correction failure must not open the dictation breaker, and vice
// versa.

export interface ClaudeBreaker {
  /** True when the breaker is OPEN — skip the call. */
  isOpen(): boolean
  recordFailure(): void
  recordSuccess(): void
}

export function createBreaker(opts: {
  label: string
  maxFailures?: number
  cooldownMs?: number
}): ClaudeBreaker {
  const maxFailures = opts.maxFailures ?? 2
  const cooldownMs = opts.cooldownMs ?? 30 * 60 * 1000 // 30 minutes
  let consecutiveFailures = 0
  let openedAt = 0

  return {
    isOpen(): boolean {
      if (consecutiveFailures < maxFailures) return false
      const elapsed = Date.now() - openedAt
      if (elapsed >= cooldownMs) {
        // Half-open: allow one attempt to see if it recovered.
        console.log(`[${opts.label}] circuit HALF-OPEN — cooldown elapsed (${(elapsed / 60000).toFixed(0)}min), trying one call`)
        return false
      }
      return true
    },
    recordFailure(): void {
      consecutiveFailures++
      if (consecutiveFailures >= maxFailures) {
        openedAt = Date.now()
        console.error(`[${opts.label}] ⚠ circuit OPEN — ${consecutiveFailures} consecutive failures. Retry in ${(cooldownMs / 60000).toFixed(0)}min`)
      }
    },
    recordSuccess(): void {
      if (consecutiveFailures > 0) {
        console.log(`[${opts.label}] circuit CLOSED — recovered after ${consecutiveFailures} failure(s)`)
        consecutiveFailures = 0
        openedAt = 0
      }
    },
  }
}
