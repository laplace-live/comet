/**
 * Backfill throttle / backoff policy (spec section 10).
 *
 * Pure, side-effect-free state machine. The crawler owns the wall-clock waiting;
 * this module only decides the next delay, the next state, and what to do.
 */

export type BiliErrorKind = 'ok' | 'blocked' | 'too_frequent' | 'not_logged_in' | 'other'

/**
 * Classify a Bilibili read response.
 * @param code   response `code` field, or null when the body was a non-JSON block page
 * @param blocked true when a -412 HTML block page was detected (JSON.parse failed)
 */
export function classifyError(code: number | null, blocked: boolean): BiliErrorKind {
  if (blocked || code === -412) return 'blocked'
  if (code === 0) return 'ok'
  if (code === -509 || code === -799) return 'too_frequent'
  if (code === -101) return 'not_logged_in'
  return 'other'
}

export interface BackoffState {
  attempt: number
  baseDelayMs: number
}

export interface BackoffDecision {
  delayMs: number
  nextState: BackoffState
  action: 'continue' | 'retry' | 'pause' | 'abort'
}

// Exponential schedules (ms). Index by current attempt.
const BLOCKED_SCHEDULE_MS = [30_000, 60_000, 120_000, 300_000]
const TOO_FREQUENT_SCHEDULE_MS = [10_000, 30_000, 90_000]

// Long cooldown after the blocked schedule is exhausted (30 min, spec: 30-60 min).
const BLOCKED_PAUSE_MS = 1_800_000
// Raised base delay band (6-8 s) after repeated "too frequent" responses.
const RAISED_BASE_DELAY_MS = 7000

/**
 * Decide the next backoff step for the given error kind.
 *
 * - ok            -> continue at base delay; attempt untouched
 * - blocked       -> retry 30/60/120/300s; once exhausted -> pause for the cooldown window, reset attempt
 * - too_frequent  -> retry 10/30/90s; once exhausted -> raise base delay (never lower it), reset attempt, retry at new base
 * - not_logged_in -> abort
 * - other         -> pause (caller decides whether to resume)
 */
export function nextBackoff(kind: BiliErrorKind, state: BackoffState): BackoffDecision {
  switch (kind) {
    case 'ok':
      return {
        delayMs: state.baseDelayMs,
        nextState: { attempt: 0, baseDelayMs: state.baseDelayMs },
        action: 'continue',
      }

    case 'blocked': {
      if (state.attempt < BLOCKED_SCHEDULE_MS.length) {
        return {
          delayMs: BLOCKED_SCHEDULE_MS[state.attempt],
          nextState: { attempt: state.attempt + 1, baseDelayMs: state.baseDelayMs },
          action: 'retry',
        }
      }
      return {
        delayMs: BLOCKED_PAUSE_MS,
        nextState: { attempt: 0, baseDelayMs: state.baseDelayMs },
        action: 'pause',
      }
    }

    case 'too_frequent': {
      if (state.attempt < TOO_FREQUENT_SCHEDULE_MS.length) {
        return {
          delayMs: TOO_FREQUENT_SCHEDULE_MS[state.attempt],
          nextState: { attempt: state.attempt + 1, baseDelayMs: state.baseDelayMs },
          action: 'retry',
        }
      }
      // Schedule exhausted: raise the base delay (never lower it), reset attempt, retry at new base.
      const raised = Math.max(state.baseDelayMs, RAISED_BASE_DELAY_MS)
      return {
        delayMs: raised,
        nextState: { attempt: 0, baseDelayMs: raised },
        action: 'retry',
      }
    }

    case 'not_logged_in':
      return {
        delayMs: 0,
        nextState: { attempt: state.attempt, baseDelayMs: state.baseDelayMs },
        action: 'abort',
      }

    default:
      return {
        delayMs: state.baseDelayMs,
        nextState: { attempt: state.attempt, baseDelayMs: state.baseDelayMs },
        action: 'pause',
      }
  }
}
