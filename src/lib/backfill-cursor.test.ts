import { describe, expect, it } from 'vitest'

import type { ConvCursor } from '@/lib/backfill-cursor'

import { dedupeBoundarySessions, nextBackfillCursor } from '@/lib/backfill-cursor'

const EMPTY_MIN = '18446744073709551615'
const EMPTY_MAX = '0'

function freshCursor(): ConvCursor {
  return { oldestSeqno: null, backfillDone: false, newestSeqno: null, newestMsgKey: null }
}

describe('nextBackfillCursor - backward walk', () => {
  it('advances oldestSeqno to the page min and sets exclusive nextEndSeqno = min', () => {
    const cursor = freshCursor()
    const {
      cursor: next,
      nextEndSeqno,
      done,
    } = nextBackfillCursor(cursor, {
      minSeqno: '500',
      maxSeqno: '900',
      hasMore: true,
      empty: false,
    })
    expect(next.oldestSeqno).toBe('500')
    expect(nextEndSeqno).toBe('500')
    expect(done).toBe(false)
    expect(next.backfillDone).toBe(false)
  })

  it('keeps newestSeqno/newestMsgKey untouched (backward walk only lowers the floor)', () => {
    const cursor: ConvCursor = {
      oldestSeqno: '500',
      backfillDone: false,
      newestSeqno: '900',
      newestMsgKey: 'k900',
    }
    const { cursor: next } = nextBackfillCursor(cursor, {
      minSeqno: '300',
      maxSeqno: '499',
      hasMore: true,
      empty: false,
    })
    expect(next.oldestSeqno).toBe('300')
    expect(next.newestSeqno).toBe('900')
    expect(next.newestMsgKey).toBe('k900')
  })

  it('marks done + backfillDone when has_more is false (reached genesis)', () => {
    const cursor = freshCursor()
    const {
      cursor: next,
      nextEndSeqno,
      done,
    } = nextBackfillCursor(cursor, {
      minSeqno: '100',
      maxSeqno: '200',
      hasMore: false,
      empty: false,
    })
    expect(done).toBe(true)
    expect(next.backfillDone).toBe(true)
    expect(next.oldestSeqno).toBe('100')
    // floor still advances so a forward sweep knows the indexed lower bound
    expect(nextEndSeqno).toBe('100')
  })

  it('treats the empty-history sentinel page as done with no floor change', () => {
    const cursor = freshCursor()
    const {
      cursor: next,
      nextEndSeqno,
      done,
    } = nextBackfillCursor(cursor, {
      minSeqno: EMPTY_MIN,
      maxSeqno: EMPTY_MAX,
      hasMore: false,
      empty: true,
    })
    expect(done).toBe(true)
    expect(next.backfillDone).toBe(true)
    expect(next.oldestSeqno).toBeNull()
    expect(nextEndSeqno).toBeNull()
  })

  it('produces no overlap and no gap across consecutive pages', () => {
    // page 1: [500..900], page 2 must request end_seqno=500 exclusive -> [300..499]
    let cursor = freshCursor()
    let r = nextBackfillCursor(cursor, { minSeqno: '500', maxSeqno: '900', hasMore: true, empty: false })
    expect(r.nextEndSeqno).toBe('500')
    cursor = r.cursor

    // simulate the next page fetched with end_seqno=500 returning strictly older msgs
    r = nextBackfillCursor(cursor, { minSeqno: '300', maxSeqno: '499', hasMore: false, empty: false })
    // 499 < 500 -> contiguous, no overlap, no gap
    expect(Number(r.cursor.oldestSeqno)).toBeLessThan(500)
    expect(r.done).toBe(true)
  })
})

describe('dedupeBoundarySessions', () => {
  it('returns the page untouched when prevEndTs is null (first page)', () => {
    const out = dedupeBoundarySessions(null, {
      sessions: [
        { talkerId: 1, sessionTs: '300' },
        { talkerId: 2, sessionTs: '200' },
      ],
      hasMore: true,
    })
    expect(out).toHaveLength(2)
    expect(out[0].talkerId).toBe(1)
  })

  it('drops the leading boundary duplicate whose sessionTs equals prevEndTs', () => {
    const out = dedupeBoundarySessions('300', {
      sessions: [
        { talkerId: 1, sessionTs: '300' }, // boundary dup carried over from previous page end
        { talkerId: 2, sessionTs: '200' },
        { talkerId: 3, sessionTs: '100' },
      ],
      hasMore: true,
    })
    expect(out).toHaveLength(2)
    expect(out[0].talkerId).toBe(2)
    expect(out[1].talkerId).toBe(3)
  })

  it('only drops a LEADING duplicate, never a later same-ts item', () => {
    const out = dedupeBoundarySessions('999', {
      sessions: [
        { talkerId: 1, sessionTs: '300' },
        { talkerId: 2, sessionTs: '999' }, // same ts but not leading -> keep
      ],
      hasMore: true,
    })
    expect(out).toHaveLength(2)
    expect(out[0].talkerId).toBe(1)
    expect(out[1].talkerId).toBe(2)
  })

  it('returns an empty array for an empty page', () => {
    const out = dedupeBoundarySessions('300', { sessions: [], hasMore: false })
    expect(out).toEqual([])
  })
})
