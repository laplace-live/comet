/**
 * Backfill pagination cursor math (spec section 10).
 *
 * Pure helpers that compute the next request boundary and whether a backward
 * walk has reached genesis. Seqno / ts values are strings (they can exceed 2^53).
 */

/** Empty-history sentinel returned by fetch_session_msgs for a conversation with no messages. */
const EMPTY_MIN_SEQNO = '18446744073709551615'
const EMPTY_MAX_SEQNO = '0'

export interface ConvCursor {
  oldestSeqno: string | null
  backfillDone: boolean
  newestSeqno: string | null
  newestMsgKey: string | null
}

export interface MsgPage {
  minSeqno: string
  maxSeqno: string
  hasMore: boolean
  /** true when messages were null OR the empty-history sentinel was returned. */
  empty: boolean
}

/**
 * Detect the empty-history sentinel page.
 * Exposed so the crawler can derive MsgPage.empty consistently from a raw response.
 */
export function isEmptyMsgPage(minSeqno: string, maxSeqno: string, messagesNull: boolean): boolean {
  if (messagesNull) return true
  return minSeqno === EMPTY_MIN_SEQNO && maxSeqno === EMPTY_MAX_SEQNO
}

/**
 * Advance the backward backfill cursor by one page.
 *
 * - nextEndSeqno = page.minSeqno is the EXCLUSIVE end_seqno for the next request (no overlap).
 * - oldestSeqno is lowered to page.minSeqno (the new indexed floor).
 * - done when the page reports no more history OR is the empty sentinel.
 * - backfillDone mirrors `done` once reached (never un-set here).
 * - newestSeqno / newestMsgKey are owned by the forward sweep and pass through untouched.
 */
export function nextBackfillCursor(
  cursor: ConvCursor,
  page: MsgPage
): { cursor: ConvCursor; nextEndSeqno: string | null; done: boolean } {
  if (page.empty) {
    const done = true
    return {
      cursor: { ...cursor, backfillDone: true },
      nextEndSeqno: null,
      done,
    }
  }

  const done = !page.hasMore
  return {
    cursor: {
      ...cursor,
      oldestSeqno: page.minSeqno,
      backfillDone: cursor.backfillDone || done,
    },
    nextEndSeqno: page.minSeqno,
    done,
  }
}

export interface SessionPage {
  sessions: Array<{ talkerId: number; sessionTs: string }>
  hasMore: boolean
}

/**
 * Drop the leading boundary-duplicate session.
 *
 * get_sessions paginates by `end_ts = session_ts of the last item`, so the first
 * item of the next page repeats the previous page's last item. When prevEndTs is
 * set, drop a LEADING session whose sessionTs === prevEndTs. Only the leading item
 * is considered (a later same-ts item is a distinct conversation and is kept).
 */
export function dedupeBoundarySessions(
  prevEndTs: string | null,
  page: SessionPage
): Array<{ talkerId: number; sessionTs: string }> {
  if (prevEndTs === null) return page.sessions
  if (page.sessions.length === 0) return page.sessions
  if (page.sessions[0].sessionTs === prevEndTs) {
    return page.sessions.slice(1)
  }
  return page.sessions
}
