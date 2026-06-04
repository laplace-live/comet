/**
 * Backfill crawler orchestrator.
 *
 * A single serial, resumable walk over conversations and their message history.
 * All IO (network fetch, indexing, cursor persistence, progress emission, sleeping)
 * is injected via `CrawlerDeps` so the loop is unit-testable with scripted fakes.
 *
 * Concurrency is always 1 (spec section 10: never parallelize per account).
 */

import type { ConvCursor } from '@/lib/backfill-cursor'
import type { BackoffState } from '@/lib/backfill-policy'
import type { BilibiliMessagesResponse, BilibiliSession, BilibiliSessionsResponse } from '@/types/bilibili'

import { dedupeBoundarySessions, isEmptyMsgPage, nextBackfillCursor } from '@/lib/backfill-cursor'
import { classifyError, nextBackoff } from '@/lib/backfill-policy'

// Mirrors search-index.ts exports so the production wiring is a direct pass-through.
export interface IndexedMessageInput {
  talkerId: number
  sessionType: number
  msgSeqno: string
  msgKey: string
  senderUid: number | null
  msgType: number | null
  msgSource: number | null
  timestamp: number | null
  msgStatus: number | null
  content: string
}

export interface BackfillStatus {
  state: 'idle' | 'running' | 'paused' | 'done' | 'error'
  processedConversations: number
  totalConversations: number
  indexedMessages: number
  currentTalkerId: number | null
  lastError: string | null
}

type RawSessionsResult = BilibiliSessionsResponse | { error: string; code: number }
type RawMsgsResult = BilibiliMessagesResponse | { error: string; code: number }

export interface CrawlerDeps {
  getActiveAccountMid: () => number | null
  fetchSessions: (params: { sessionType: string; size: string; endTs?: string }) => Promise<RawSessionsResult>
  fetchSessionMsgs: (params: {
    talkerId: string
    sessionType: string
    size: string
    endSeqno?: string
  }) => Promise<RawMsgsResult>
  indexSessions: (mid: number, sessions: BilibiliSession[]) => void
  indexMessages: (mid: number, messages: IndexedMessageInput[]) => void
  getConvCursor: (mid: number, key: string) => ConvCursor | undefined
  saveConvCursor: (mid: number, key: string, cursor: ConvCursor) => void
  saveAccountCursor: (mid: number, cursor: { sessionEndTs: string | null; sessionHasMore: boolean }) => void
  emitProgress: (status: BackfillStatus) => void
  sleep: (ms: number) => Promise<void>
  /** returns a jittered base delay in ms (production: 2000-4000) */
  jitter: (baseMs: number) => number
}

const SESSIONS_PAGE_SIZE = '100'
const MSGS_PAGE_SIZE = '200'
const BASE_DELAY_MS = 3000
// Emit progress at most ~1/sec (spec section 15).
const PROGRESS_THROTTLE_MS = 1000

function convKey(talkerId: number, sessionType: number): string {
  return `${talkerId}:${sessionType}`
}

function isError(r: RawSessionsResult | RawMsgsResult): r is { error: string; code: number } {
  return 'error' in r
}

export interface BackfillCrawler {
  start: (opts?: { sessionType?: number }) => void
  pause: () => void
  resume: () => void
  getStatus: () => BackfillStatus
  /** resolves when the loop has reached a terminal/paused/idle resting state */
  waitIdle: () => Promise<void>
}

export function createBackfillCrawler(deps: CrawlerDeps): BackfillCrawler {
  let status: BackfillStatus = {
    state: 'idle',
    processedConversations: 0,
    totalConversations: 0,
    indexedMessages: 0,
    currentTalkerId: null,
    lastError: null,
  }

  let paused = false
  let running = false
  let runPromise: Promise<void> | null = null
  let backoff: BackoffState = { attempt: 0, baseDelayMs: BASE_DELAY_MS }
  let lastProgressAt = 0
  let sessionType = 1

  function publish(force = false): void {
    const now = Date.now()
    if (!force && now - lastProgressAt < PROGRESS_THROTTLE_MS) return
    lastProgressAt = now
    deps.emitProgress({ ...status })
  }

  /**
   * Perform one fetch with backoff handling.
   * Retries `blocked`/`too_frequent` in place; returns null on abort/pause/empty-other.
   * Returns the successful response otherwise.
   */
  async function fetchWithBackoff<T extends RawSessionsResult | RawMsgsResult>(
    doFetch: () => Promise<T>
  ): Promise<Exclude<T, { error: string; code: number }> | null> {
    // serial retry loop with internal breaks
    for (;;) {
      if (paused) return null
      const result = await doFetch()

      const code = isError(result) ? result.code : result.code
      const blocked = isError(result) && result.code === -412
      const kind = classifyError(code, blocked)

      if (kind === 'ok') {
        backoff = { attempt: 0, baseDelayMs: backoff.baseDelayMs }
        return result as Exclude<T, { error: string; code: number }>
      }

      const decision = nextBackoff(kind, backoff)
      backoff = decision.nextState

      if (decision.action === 'abort') {
        status = { ...status, state: 'error', lastError: `code=${code}` }
        publish(true)
        return null
      }
      if (decision.action === 'pause') {
        status = { ...status, state: 'paused', lastError: `code=${code}` }
        publish(true)
        paused = true
        await deps.sleep(decision.delayMs)
        return null
      }
      // action === 'retry'
      await deps.sleep(decision.delayMs)
      if (paused) return null
    }
  }

  /** Backfill a single conversation backward to genesis (or until paused/aborted). */
  async function backfillConversation(mid: number, talkerId: number): Promise<boolean> {
    const key = convKey(talkerId, sessionType)
    let cursor: ConvCursor = deps.getConvCursor(mid, key) ?? {
      oldestSeqno: null,
      backfillDone: false,
      newestSeqno: null,
      newestMsgKey: null,
    }

    if (cursor.backfillDone) return true

    // resume from the recorded floor (exclusive end_seqno)
    let endSeqno: string | undefined = cursor.oldestSeqno ?? undefined

    // paged walk with internal breaks
    for (;;) {
      if (paused) return false

      const resp = await fetchWithBackoff(() =>
        deps.fetchSessionMsgs({
          talkerId: String(talkerId),
          sessionType: String(sessionType),
          size: MSGS_PAGE_SIZE,
          endSeqno,
        })
      )
      if (resp === null) return false // aborted or paused mid-page

      const data = resp.data
      const messages = data.messages ?? []
      const minSeqno = String(data.min_seqno)
      const maxSeqno = String(data.max_seqno)
      const empty = isEmptyMsgPage(minSeqno, maxSeqno, data.messages === null)

      if (!empty && messages.length > 0) {
        const input: IndexedMessageInput[] = messages.map(m => ({
          talkerId,
          sessionType,
          msgSeqno: String(m.msg_seqno),
          msgKey: String(m.msg_key),
          senderUid: m.sender_uid ?? null,
          msgType: m.msg_type ?? null,
          msgSource: m.msg_source ?? null,
          timestamp: m.timestamp ?? null,
          msgStatus: m.msg_status ?? null,
          content: m.content,
        }))
        deps.indexMessages(mid, input)
        status = { ...status, indexedMessages: status.indexedMessages + input.length }
      }

      const advanced = nextBackfillCursor(cursor, {
        minSeqno,
        maxSeqno,
        hasMore: data.has_more === 1,
        empty,
      })
      cursor = advanced.cursor
      deps.saveConvCursor(mid, key, cursor)
      publish()

      if (advanced.done) return true
      endSeqno = advanced.nextEndSeqno ?? undefined

      // base inter-page delay
      await deps.sleep(deps.jitter(backoff.baseDelayMs))
    }
  }

  async function run(): Promise<void> {
    running = true
    paused = false
    status = { ...status, state: 'running', lastError: null }
    publish(true)

    const mid = deps.getActiveAccountMid()
    if (mid === null) {
      status = { ...status, state: 'error', lastError: 'no active account' }
      publish(true)
      running = false
      return
    }

    // ---- walk the conversation list, backfilling each conversation ----------
    let endTs: string | undefined
    let prevEndTs: string | null = null

    // paged walk with internal breaks
    for (;;) {
      if (paused) break

      const resp = await fetchWithBackoff(() =>
        deps.fetchSessions({ sessionType: String(sessionType), size: SESSIONS_PAGE_SIZE, endTs })
      )
      if (resp === null) break // aborted or paused

      const list = resp.data.session_list ?? []
      if (list.length === 0) break

      // mirror session metadata for offline conversation search
      deps.indexSessions(mid, list)

      const deduped = dedupeBoundarySessions(prevEndTs, {
        sessions: list.map(s => ({ talkerId: s.talker_id, sessionTs: String(s.session_ts) })),
        hasMore: resp.data.has_more === 1,
      })

      status = { ...status, totalConversations: status.totalConversations + deduped.length }
      publish()

      for (const s of deduped) {
        if (paused) break
        status = { ...status, currentTalkerId: s.talkerId }
        publish()
        const finished = await backfillConversation(mid, s.talkerId)
        if (paused) break
        if (finished) {
          status = { ...status, processedConversations: status.processedConversations + 1 }
          publish()
        }
      }

      if (paused) break
      if (resp.data.has_more !== 1) {
        // reached the end of the conversation list
        deps.saveAccountCursor(mid, { sessionEndTs: null, sessionHasMore: false })
        break
      }

      // page back via end_ts = session_ts of the last item
      prevEndTs = String(list[list.length - 1].session_ts)
      endTs = prevEndTs
      deps.saveAccountCursor(mid, { sessionEndTs: endTs, sessionHasMore: true })
      await deps.sleep(deps.jitter(backoff.baseDelayMs))
    }

    // terminal state resolution
    if (status.state === 'error') {
      // keep error
    } else if (paused) {
      status = { ...status, state: 'paused' }
    } else {
      status = { ...status, state: 'done', currentTalkerId: null }
    }
    publish(true)
    running = false
  }

  return {
    start(opts) {
      if (running) return
      sessionType = opts?.sessionType ?? 1
      backoff = { attempt: 0, baseDelayMs: BASE_DELAY_MS }
      runPromise = run()
    },
    pause() {
      paused = true
    },
    resume() {
      if (running) return
      paused = false
      status = { ...status, state: 'running', lastError: null }
      runPromise = run()
    },
    getStatus() {
      return { ...status }
    },
    async waitIdle() {
      if (runPromise) await runPromise
    },
  }
}
