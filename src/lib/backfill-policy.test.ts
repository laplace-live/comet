import { describe, expect, it } from 'vitest'

import type { BackoffState } from '@/lib/backfill-policy'

import { classifyError, nextBackoff } from '@/lib/backfill-policy'

describe('classifyError', () => {
  it('returns ok for code 0', () => {
    expect(classifyError(0, false)).toBe('ok')
  })

  it('returns blocked when blocked flag set (HTML block page, null code)', () => {
    expect(classifyError(null, true)).toBe('blocked')
  })

  it('returns blocked for code -412 even without the html flag', () => {
    expect(classifyError(-412, false)).toBe('blocked')
  })

  it('returns too_frequent for -509 and -799', () => {
    expect(classifyError(-509, false)).toBe('too_frequent')
    expect(classifyError(-799, false)).toBe('too_frequent')
  })

  it('returns not_logged_in for -101', () => {
    expect(classifyError(-101, false)).toBe('not_logged_in')
  })

  it('returns other for any unmapped non-zero code', () => {
    expect(classifyError(-1, false)).toBe('other')
    expect(classifyError(404, false)).toBe('other')
  })

  it('returns other for a null code with no block flag', () => {
    expect(classifyError(null, false)).toBe('other')
  })
})

describe('nextBackoff - ok', () => {
  it('continues at the current base delay without advancing attempt', () => {
    const state: BackoffState = { attempt: 0, baseDelayMs: 3000 }
    const d = nextBackoff('ok', state)
    expect(d.action).toBe('continue')
    expect(d.delayMs).toBe(3000)
    expect(d.nextState).toEqual({ attempt: 0, baseDelayMs: 3000 })
  })
})

describe('nextBackoff - blocked (30/60/120/300 cap then pause)', () => {
  it('walks the blocked schedule and caps, then pauses past the schedule', () => {
    let state: BackoffState = { attempt: 0, baseDelayMs: 3000 }

    let d = nextBackoff('blocked', state)
    expect(d.action).toBe('retry')
    expect(d.delayMs).toBe(30_000)
    expect(d.nextState.attempt).toBe(1)
    state = d.nextState

    d = nextBackoff('blocked', state)
    expect(d.action).toBe('retry')
    expect(d.delayMs).toBe(60_000)
    expect(d.nextState.attempt).toBe(2)
    state = d.nextState

    d = nextBackoff('blocked', state)
    expect(d.action).toBe('retry')
    expect(d.delayMs).toBe(120_000)
    expect(d.nextState.attempt).toBe(3)
    state = d.nextState

    d = nextBackoff('blocked', state)
    expect(d.action).toBe('retry')
    expect(d.delayMs).toBe(300_000)
    expect(d.nextState.attempt).toBe(4)
    state = d.nextState

    // schedule exhausted -> pause for the long cooldown window
    d = nextBackoff('blocked', state)
    expect(d.action).toBe('pause')
    expect(d.delayMs).toBe(1_800_000)
    expect(d.nextState.attempt).toBe(0)
  })

  it('preserves baseDelayMs across blocked retries', () => {
    const d = nextBackoff('blocked', { attempt: 0, baseDelayMs: 4000 })
    expect(d.nextState.baseDelayMs).toBe(4000)
  })
})

describe('nextBackoff - too_frequent (10/30/90 then raise base)', () => {
  it('walks the schedule then raises base delay and resets attempt', () => {
    let state: BackoffState = { attempt: 0, baseDelayMs: 3000 }

    let d = nextBackoff('too_frequent', state)
    expect(d.action).toBe('retry')
    expect(d.delayMs).toBe(10_000)
    expect(d.nextState.attempt).toBe(1)
    expect(d.nextState.baseDelayMs).toBe(3000)
    state = d.nextState

    d = nextBackoff('too_frequent', state)
    expect(d.action).toBe('retry')
    expect(d.delayMs).toBe(30_000)
    expect(d.nextState.attempt).toBe(2)
    state = d.nextState

    d = nextBackoff('too_frequent', state)
    expect(d.action).toBe('retry')
    expect(d.delayMs).toBe(90_000)
    expect(d.nextState.attempt).toBe(3)
    state = d.nextState

    // schedule exhausted -> raise base into the 6-8s band and reset attempt
    d = nextBackoff('too_frequent', state)
    expect(d.action).toBe('retry')
    expect(d.delayMs).toBe(7000)
    expect(d.nextState.attempt).toBe(0)
    expect(d.nextState.baseDelayMs).toBe(7000)
  })

  it('does not lower an already-raised base delay', () => {
    const state: BackoffState = { attempt: 3, baseDelayMs: 8000 }
    const d = nextBackoff('too_frequent', state)
    expect(d.nextState.baseDelayMs).toBe(8000)
    expect(d.delayMs).toBe(8000)
  })
})

describe('nextBackoff - not_logged_in / other', () => {
  it('aborts immediately on not_logged_in', () => {
    const d = nextBackoff('not_logged_in', { attempt: 2, baseDelayMs: 3000 })
    expect(d.action).toBe('abort')
    expect(d.delayMs).toBe(0)
  })

  it('pauses on an unknown other error', () => {
    const d = nextBackoff('other', { attempt: 0, baseDelayMs: 3000 })
    expect(d.action).toBe('pause')
  })
})
