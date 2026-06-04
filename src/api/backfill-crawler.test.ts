import { describe, expect, it, vi } from 'vitest'

import type { CrawlerDeps } from '@/api/backfill-crawler'
import type { BilibiliMessagesResponse, BilibiliSessionsResponse } from '@/types/bilibili'

import { createBackfillCrawler } from '@/api/backfill-crawler'

// ---- scripted response builders -------------------------------------------

function sessionsResp(
  list: Array<{ talker_id: number; session_ts: number }>,
  hasMore: number
): BilibiliSessionsResponse {
  return {
    code: 0,
    msg: '0',
    message: '0',
    ttl: 1,
    data: {
      session_list: list.map(s => ({
        talker_id: s.talker_id,
        session_type: 1,
        session_ts: s.session_ts,
        last_msg: null,
        unread_count: 0,
        group_name: '',
        // remaining BilibiliSession fields are not read by the crawler
      })) as BilibiliSessionsResponse['data']['session_list'],
      has_more: hasMore,
      anti_disturb_cleaning: false,
      is_address_list_empty: 0,
      show_level: false,
    },
  }
}

function msgsResp(
  msgs: Array<{ msg_seqno: number; msg_key: string }>,
  minSeqno: number,
  maxSeqno: number,
  hasMore: number
): BilibiliMessagesResponse {
  return {
    code: 0,
    msg: '0',
    message: '0',
    ttl: 1,
    data: {
      messages: msgs.map(m => ({
        sender_uid: 1,
        receiver_type: 1,
        receiver_id: 2,
        msg_type: 1,
        content: '{"content":"hi"}',
        msg_seqno: m.msg_seqno,
        timestamp: 1700000000,
        at_uids: null,
        msg_key: m.msg_key,
        msg_status: 0,
        notify_code: '',
        msg_source: 0,
      })),
      has_more: hasMore,
      min_seqno: minSeqno,
      max_seqno: maxSeqno,
    },
  }
}

// A blocked (-412) page surfaced by the raw fetcher when JSON.parse fails.
const BLOCKED = { error: 'blocked', code: -412 } as const

function makeDeps(overrides: Partial<CrawlerDeps> = {}): {
  deps: CrawlerDeps
  indexed: number[]
  convCursors: Map<string, unknown>
  progress: unknown[]
} {
  const indexed: number[] = []
  const convCursors = new Map<string, unknown>()
  const progress: unknown[] = []

  const deps: CrawlerDeps = {
    getActiveAccountMid: () => 42,
    fetchSessions: vi.fn(async () => sessionsResp([], 0)),
    // default empty page; min/max are never read in tests that use the default deps
    // (those tests return an empty session list, so messages are never fetched).
    fetchSessionMsgs: vi.fn(async () => msgsResp([], 0, 0, 0)),
    indexSessions: vi.fn(),
    indexMessages: vi.fn((_mid: number, msgs: Array<{ msgSeqno: string }>) => {
      for (const m of msgs) indexed.push(Number(m.msgSeqno))
    }),
    getConvCursor: vi.fn((_mid: number, key: string) => convCursors.get(key) as never),
    saveConvCursor: vi.fn((_mid: number, key: string, cursor: unknown) => {
      convCursors.set(key, cursor)
    }),
    saveAccountCursor: vi.fn(),
    emitProgress: vi.fn((s: unknown) => {
      progress.push(s)
    }),
    // make delays instant so the test runs fast
    sleep: vi.fn(async () => {
      // no-op: instant sleep
    }),
    jitter: () => 3000,
    ...overrides,
  }
  return { deps, indexed, convCursors, progress }
}

describe('createBackfillCrawler', () => {
  it('crawls one conversation, indexes messages, advances cursors, finishes done', async () => {
    const { deps, indexed } = makeDeps({
      // one conversation in the session list
      fetchSessions: vi.fn(async () => sessionsResp([{ talker_id: 7, session_ts: 1000 }], 0)),
      // two message pages then genesis
      fetchSessionMsgs: vi
        .fn()
        .mockResolvedValueOnce(msgsResp([{ msg_seqno: 900, msg_key: 'k900' }], 800, 900, 1))
        .mockResolvedValueOnce(msgsResp([{ msg_seqno: 700, msg_key: 'k700' }], 600, 700, 0)),
    })

    const crawler = createBackfillCrawler(deps)
    crawler.start({ sessionType: 1 })
    await crawler.waitIdle()

    // both pages' messages indexed
    expect(indexed.sort((a, b) => a - b)).toEqual([700, 900])

    // second fetch used the exclusive end_seqno from page 1 (min_seqno=800)
    const calls = (deps.fetchSessionMsgs as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][0]).toMatchObject({ talkerId: '7' })
    expect(calls[1][0]).toMatchObject({ endSeqno: '800' })

    // conv cursor persisted as done at the genesis floor
    expect(deps.saveConvCursor).toHaveBeenCalled()
    const lastCursor = (deps.saveConvCursor as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2] as {
      oldestSeqno: string
      backfillDone: boolean
    }
    expect(lastCursor.oldestSeqno).toBe('600')
    expect(lastCursor.backfillDone).toBe(true)

    // ended in a terminal state
    expect(crawler.getStatus().state).toBe('done')
  })

  it('retries after a -412 blocked page then succeeds (backoff applied, no data lost)', async () => {
    const { deps, indexed } = makeDeps({
      fetchSessions: vi.fn(async () => sessionsResp([{ talker_id: 7, session_ts: 1000 }], 0)),
      fetchSessionMsgs: vi
        .fn()
        .mockResolvedValueOnce(BLOCKED) // first attempt blocked
        .mockResolvedValueOnce(msgsResp([{ msg_seqno: 900, msg_key: 'k900' }], 900, 900, 0)),
    })

    const crawler = createBackfillCrawler(deps)
    crawler.start({ sessionType: 1 })
    await crawler.waitIdle()

    // the blocked page was retried and the real page indexed
    expect(indexed).toEqual([900])
    // sleep was called with the blocked backoff (30s) at least once
    const sleepArgs = (deps.sleep as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(sleepArgs).toContain(30_000)
    expect(crawler.getStatus().state).toBe('done')
  })

  it('aborts and flags error on a not-logged-in (-101) response', async () => {
    const { deps, indexed } = makeDeps({
      fetchSessions: vi.fn(async () => ({ error: 'not logged in', code: -101 })),
    })

    const crawler = createBackfillCrawler(deps)
    crawler.start({ sessionType: 1 })
    await crawler.waitIdle()

    expect(indexed).toEqual([])
    expect(crawler.getStatus().state).toBe('error')
    expect(crawler.getStatus().lastError).toContain('-101')
  })

  it('skips conversations already marked backfillDone (resumable)', async () => {
    const fetchMsgs = vi.fn(async () => msgsResp([{ msg_seqno: 1, msg_key: 'k1' }], 1, 1, 0))
    const { deps, indexed } = makeDeps({
      fetchSessions: vi.fn(async () => sessionsResp([{ talker_id: 7, session_ts: 1000 }], 0)),
      fetchSessionMsgs: fetchMsgs,
      getConvCursor: vi.fn(() => ({
        oldestSeqno: '1',
        backfillDone: true,
        newestSeqno: '1',
        newestMsgKey: 'k1',
      })),
    })

    const crawler = createBackfillCrawler(deps)
    crawler.start({ sessionType: 1 })
    await crawler.waitIdle()

    expect(fetchMsgs).not.toHaveBeenCalled()
    expect(indexed).toEqual([])
    expect(crawler.getStatus().state).toBe('done')
  })

  it('pause() halts the loop and resume() lets it finish', async () => {
    let releaseSecondPage: (v: BilibiliMessagesResponse) => void = () => {
      // no-op: replaced by the Promise executor below
    }
    const secondPage = new Promise<BilibiliMessagesResponse>(res => {
      releaseSecondPage = res
    })
    const fetchMsgs = vi
      .fn()
      .mockResolvedValueOnce(msgsResp([{ msg_seqno: 900, msg_key: 'k900' }], 800, 900, 1))
      .mockImplementationOnce(() => secondPage)

    const { deps, indexed } = makeDeps({
      fetchSessions: vi.fn(async () => sessionsResp([{ talker_id: 7, session_ts: 1000 }], 0)),
      fetchSessionMsgs: fetchMsgs,
    })

    const crawler = createBackfillCrawler(deps)
    crawler.start({ sessionType: 1 })

    // let the first page resolve, then pause before the second completes
    await vi.waitFor(() => expect(indexed).toContain(900))
    crawler.pause()
    releaseSecondPage(msgsResp([{ msg_seqno: 700, msg_key: 'k700' }], 600, 700, 0))
    await crawler.waitIdle()

    expect(crawler.getStatus().state).toBe('paused')

    crawler.resume()
    await crawler.waitIdle()
    expect(indexed.sort((a, b) => a - b)).toEqual([700, 900])
    expect(crawler.getStatus().state).toBe('done')
  })
})
