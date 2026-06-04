import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { IndexedMessageInput } from '@/api/search-index'
import type { BilibiliSession } from '@/types/bilibili'

import {
  closeSearchIndex,
  getIndexStats,
  indexMessages,
  indexSessions,
  initSearchIndex,
  querySearch,
} from '@/api/search-index'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3-multiple-ciphers')

const KEY = 'a'.repeat(64) // 64 hex chars = 32-byte raw key

// Re-open the same file/handle the module opened, to read sqlite_master back out.
// Since the module owns the connection, we expose a tiny test accessor below.
afterEach(() => {
  closeSearchIndex()
})

async function objectNames(): Promise<Set<string>> {
  // Reach into the module's live connection via the exported __getDbForTest.
  const mod = await import('@/api/search-index')
  const db = (mod as unknown as { __getDbForTest(): InstanceType<typeof Database> }).__getDbForTest()
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{
    name: string
  }>
  return new Set(rows.map(r => r.name))
}

describe('initSearchIndex', () => {
  it('creates all tables, the fts table, and sync triggers', async () => {
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: KEY })
    const names = await objectNames()
    for (const t of [
      'messages',
      'messages_fts',
      'sessions',
      'users',
      'account_cursors',
      'conv_cursors',
      'schema_version',
    ]) {
      expect(names.has(t)).toBe(true)
    }
    // FTS sync triggers
    expect(names.has('messages_ai')).toBe(true)
    expect(names.has('messages_ad')).toBe(true)
    expect(names.has('messages_au')).toBe(true)
  })

  it('records the schema version', async () => {
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: KEY })
    const mod = await import('@/api/search-index')
    const db = (mod as unknown as { __getDbForTest(): InstanceType<typeof Database> }).__getDbForTest()
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
    expect(row.v).toBeGreaterThanOrEqual(1)
  })

  it('is idempotent: a second init on a fresh handle does not throw', async () => {
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: KEY })
    closeSearchIndex()
    await expect(initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: KEY })).resolves.toBeUndefined()
  })

  it('opens a real temp file with the cipher key and round-trips a row', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'comet-index-'))
    const file = join(dir, 'index.db')
    await initSearchIndex({ dbPath: file, encryptionKeyHex: KEY })
    const mod = await import('@/api/search-index')
    const db = (mod as unknown as { __getDbForTest(): InstanceType<typeof Database> }).__getDbForTest()
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(999, Date.now())
    const n = (db.prepare('SELECT count(*) c FROM schema_version').get() as { c: number }).c
    expect(n).toBeGreaterThanOrEqual(2)
  })
})

describe('indexMessages', () => {
  async function db() {
    const mod = await import('@/api/search-index')
    return (
      mod as unknown as {
        __getDbForTest(): { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } }
      }
    ).__getDbForTest()
  }

  function textMsg(
    over: Partial<import('@/api/search-index').IndexedMessageInput>
  ): import('@/api/search-index').IndexedMessageInput {
    return {
      talkerId: 1001,
      sessionType: 1,
      msgSeqno: '6900000000000000001',
      msgKey: '7400000000000000001',
      senderUid: 1001,
      msgType: 1,
      msgSource: 0,
      timestamp: 1700000000,
      msgStatus: 0,
      content: JSON.stringify({ content: '你好世界这是一条测试消息' }),
      ...over,
    }
  }

  it('inserts a message row and populates the FTS index', async () => {
    const { initSearchIndex, indexMessages } = await import('@/api/search-index')
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
    indexMessages(42, [textMsg({})])

    const h = await db()
    const row = h.prepare('SELECT * FROM messages WHERE account_mid = ?').get(42) as Record<string, unknown>
    expect(row.msg_key).toBe('7400000000000000001') // TEXT, full precision
    expect(row.msg_seqno).toBe('6900000000000000001')
    expect(row.searchable_text).toContain('测试消息')

    const hit = h
      .prepare('SELECT m.msg_key FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ?')
      .all('测试消息') as Array<{ msg_key: string }>
    expect(hit.length).toBe(1)
    expect(hit[0].msg_key).toBe('7400000000000000001')
  })

  it('is idempotent on the primary key (re-index updates, never duplicates)', async () => {
    const { initSearchIndex, indexMessages } = await import('@/api/search-index')
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
    indexMessages(42, [textMsg({ content: JSON.stringify({ content: '第一版内容' }) })])
    indexMessages(42, [textMsg({ content: JSON.stringify({ content: '第二版内容修订' }) })])

    const h = await db()
    const count = (h.prepare('SELECT count(*) c FROM messages WHERE account_mid = ?').get(42) as { c: number }).c
    expect(count).toBe(1)
    const ftsCount = (h.prepare('SELECT count(*) c FROM messages_fts').get() as { c: number }).c
    expect(ftsCount).toBe(1) // FTS row updated in place, not duplicated
    const hit = h.prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?').get('内容修订') as {
      c: number
    }
    expect(hit.c).toBe(1) // matches the NEW text
  })

  it('excludes recalled message content from FTS but stores the recall label', async () => {
    const { initSearchIndex, indexMessages } = await import('@/api/search-index')
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
    indexMessages(42, [
      textMsg({
        msgKey: '7400000000000000099',
        msgStatus: 1,
        content: JSON.stringify({ content: '机密内容不应被搜索到' }),
      }),
    ])

    const h = await db()
    const row = h
      .prepare('SELECT searchable_text, type_label, raw_json FROM messages WHERE msg_key = ?')
      .get('7400000000000000099') as { searchable_text: string | null; type_label: string | null; raw_json: string }
    expect(row.type_label).toBe('[已撤回的消息]')
    expect(row.raw_json).toContain('机密内容') // raw kept for re-render
    const ftsHit = (
      h.prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?').get('机密内容') as { c: number }
    ).c
    expect(ftsHit).toBe(0) // recalled text is NOT searchable
  })

  it('stores type_label for image messages without polluting text ranking', async () => {
    const { initSearchIndex, indexMessages } = await import('@/api/search-index')
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
    indexMessages(42, [
      textMsg({
        msgKey: '7400000000000000002',
        msgType: 2,
        content: JSON.stringify({ url: 'https://example.com/a.jpg', width: 100, height: 100 }),
      }),
    ])
    const h = await db()
    const row = h
      .prepare('SELECT searchable_text, type_label FROM messages WHERE msg_key = ?')
      .get('7400000000000000002') as {
      searchable_text: string | null
      type_label: string | null
    }
    expect(row.type_label).toBe('[图片]')
  })

  it('never throws to the caller on malformed input', async () => {
    const { initSearchIndex, indexMessages } = await import('@/api/search-index')
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
    // missing required fields / bad content must be swallowed internally
    expect(() => indexMessages(42, [{ ...textMsg({}), content: undefined as unknown as string }])).not.toThrow()
  })
})

describe('indexSessions', () => {
  async function db() {
    const mod = await import('@/api/search-index')
    return (
      mod as unknown as {
        __getDbForTest(): { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } }
      }
    ).__getDbForTest()
  }

  function session(over: Record<string, unknown>) {
    return {
      talker_id: 2002,
      session_type: 1,
      group_name: '',
      group_cover: '',
      session_ts: '1700000000000000',
      unread_count: 3,
      last_msg: {
        sender_uid: 2002,
        receiver_type: 1,
        receiver_id: 42,
        msg_type: 1,
        content: JSON.stringify({ content: '最后一条会话预览消息' }),
        msg_seqno: 1,
        timestamp: 1700000000,
        at_uids: null,
        msg_key: '7400000000000000500',
        msg_status: 0,
        notify_code: '',
        msg_source: 0,
      },
      ...over,
    } as unknown as import('@/types/bilibili').BilibiliSession
  }

  it('upserts a session row with TEXT session_ts and extracted last_msg_text', async () => {
    const { initSearchIndex, indexSessions } = await import('@/api/search-index')
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
    indexSessions(42, [session({})])

    const h = await db()
    const row = h.prepare('SELECT * FROM sessions WHERE account_mid = ? AND talker_id = ?').get(42, 2002) as Record<
      string,
      unknown
    >
    expect(row.session_ts).toBe('1700000000000000') // TEXT, full precision
    expect(row.unread_count).toBe(3)
    expect(String(row.last_msg_text)).toContain('会话预览')
  })

  it('is idempotent on (account_mid, talker_id, session_type)', async () => {
    const { initSearchIndex, indexSessions } = await import('@/api/search-index')
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
    indexSessions(42, [session({ unread_count: 1 })])
    indexSessions(42, [session({ unread_count: 9 })])
    const h = await db()
    const count = (h.prepare('SELECT count(*) c FROM sessions WHERE account_mid = ?').get(42) as { c: number }).c
    expect(count).toBe(1)
    const row = h.prepare('SELECT unread_count u FROM sessions WHERE account_mid = ?').get(42) as { u: number }
    expect(row.u).toBe(9) // updated in place
  })
})

describe('clearAccountIndex', () => {
  async function db() {
    const mod = await import('@/api/search-index')
    return (
      mod as unknown as {
        __getDbForTest(): { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } }
      }
    ).__getDbForTest()
  }

  it('purges only the target account from messages, fts, and sessions', async () => {
    const { initSearchIndex, indexMessages, clearAccountIndex } = await import('@/api/search-index')
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
    indexMessages(42, [
      {
        talkerId: 1,
        sessionType: 1,
        msgSeqno: '1',
        msgKey: '7400000000000001000',
        senderUid: 1,
        msgType: 1,
        msgSource: 0,
        timestamp: 1,
        msgStatus: 0,
        content: JSON.stringify({ content: '账号四十二的消息' }),
      },
    ])
    indexMessages(99, [
      {
        talkerId: 1,
        sessionType: 1,
        msgSeqno: '1',
        msgKey: '7400000000000002000',
        senderUid: 1,
        msgType: 1,
        msgSource: 0,
        timestamp: 1,
        msgStatus: 0,
        content: JSON.stringify({ content: '账号九十九的消息' }),
      },
    ])

    const { clearAccountIndex: clear } = await import('@/api/search-index')
    clear(42)

    const h = await db()
    const left42 = (h.prepare('SELECT count(*) c FROM messages WHERE account_mid = ?').get(42) as { c: number }).c
    const left99 = (h.prepare('SELECT count(*) c FROM messages WHERE account_mid = ?').get(99) as { c: number }).c
    expect(left42).toBe(0)
    expect(left99).toBe(1)
    // FTS for account 99 still matches; account 42's content is gone.
    expect(
      (h.prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?').get('四十二') as { c: number }).c
    ).toBe(0)
    expect(
      (h.prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?').get('九十九') as { c: number }).c
    ).toBe(1)
    void clearAccountIndex // keep both import forms referenced
  })
})

// ---------------------------------------------------------------------------
// Area D: query layer (FTS message hits, conversation hits, fallback, stats)
// ---------------------------------------------------------------------------

// MSG_TYPE.TEXT = 1
const TEXT = 1
const MID = 1001

function msg(overrides: Partial<IndexedMessageInput>): IndexedMessageInput {
  return {
    talkerId: 200,
    sessionType: 1,
    msgSeqno: '1',
    msgKey: 'k1',
    senderUid: 200,
    msgType: TEXT,
    msgSource: 0,
    timestamp: 1000,
    msgStatus: 0,
    content: JSON.stringify({ content: 'hello' }),
    ...overrides,
  }
}

describe('querySearch message hits (FTS trigram)', () => {
  beforeEach(async () => {
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
  })

  afterEach(() => {
    closeSearchIndex()
  })

  it('returns CJK message hits with snippet sentinels and account scoping', () => {
    indexMessages(MID, [
      msg({
        talkerId: 200,
        msgSeqno: '10',
        msgKey: 'k10',
        content: JSON.stringify({ content: '今天天气很好我们去公园散步' }),
      }),
      msg({ talkerId: 201, msgSeqno: '11', msgKey: 'k11', content: JSON.stringify({ content: '明天会下雨吗' }) }),
    ])
    // Different account must NOT leak into MID's results.
    indexMessages(9999, [
      msg({
        talkerId: 200,
        msgSeqno: '12',
        msgKey: 'k12',
        content: JSON.stringify({ content: '今天天气很好别的账号' }),
      }),
    ])

    const res = querySearch(MID, { query: '天气', scope: 'all', limit: 50, offset: 0 })

    expect(res.messageHits.length).toBe(1)
    const hit = res.messageHits[0]
    expect(hit.talkerId).toBe(200)
    expect(hit.msgSeqno).toBe('10')
    expect(hit.msgKey).toBe('k10')
    // Snippet must contain the contract sentinels around the matched run.
    expect(hit.snippet).toContain('\u0001')
    expect(hit.snippet).toContain('\u0002')
    expect(hit.snippet).toContain('天气')
    expect(res.total).toBe(1)
  })

  it('ranks more relevant rows first via bm25', () => {
    indexMessages(MID, [
      // Low relevance: long doc, one occurrence.
      msg({
        talkerId: 300,
        msgSeqno: '20',
        msgKey: 'k20',
        content: JSON.stringify({ content: `苹果${'其他内容'.repeat(20)}` }),
      }),
      // High relevance: short doc, repeated term.
      msg({ talkerId: 301, msgSeqno: '21', msgKey: 'k21', content: JSON.stringify({ content: '苹果苹果苹果' }) }),
    ])

    const res = querySearch(MID, { query: '苹果', scope: 'all', limit: 50, offset: 0 })

    expect(res.messageHits.length).toBe(2)
    // bm25 (smaller = better) should rank the short repeated doc first.
    expect(res.messageHits[0].msgKey).toBe('k21')
    expect(res.messageHits[1].msgKey).toBe('k20')
  })

  it('respects scope=current talkerId filtering', () => {
    indexMessages(MID, [
      msg({ talkerId: 400, msgSeqno: '30', msgKey: 'k30', content: JSON.stringify({ content: '会议记录abc' }) }),
      msg({ talkerId: 401, msgSeqno: '31', msgKey: 'k31', content: JSON.stringify({ content: '会议记录abc' }) }),
    ])

    const all = querySearch(MID, { query: '会议记录', scope: 'all', limit: 50, offset: 0 })
    expect(all.messageHits.length).toBe(2)

    const current = querySearch(MID, { query: '会议记录', scope: 'current', talkerId: 400, limit: 50, offset: 0 })
    expect(current.messageHits.length).toBe(1)
    expect(current.messageHits[0].talkerId).toBe(400)
    expect(current.total).toBe(1)
  })

  it('paginates message hits via limit/offset while total stays full', () => {
    const inputs: IndexedMessageInput[] = []
    for (let i = 0; i < 5; i++) {
      inputs.push(
        msg({
          talkerId: 500,
          msgSeqno: String(40 + i),
          msgKey: `k4${i}`,
          timestamp: 1000 + i,
          content: JSON.stringify({ content: `订单编号${i}` }),
        })
      )
    }
    indexMessages(MID, inputs)

    const page1 = querySearch(MID, { query: '订单编号', scope: 'all', limit: 2, offset: 0 })
    expect(page1.messageHits.length).toBe(2)
    expect(page1.total).toBe(5)

    const page2 = querySearch(MID, { query: '订单编号', scope: 'all', limit: 2, offset: 2 })
    expect(page2.messageHits.length).toBe(2)
    expect(page2.total).toBe(5)

    // No overlap between pages.
    const keys1 = page1.messageHits.map(h => h.msgKey)
    const keys2 = page2.messageHits.map(h => h.msgKey)
    expect(keys1.some(k => keys2.includes(k))).toBe(false)
  })

  it('ranks via FTS5 bm25 on a >=3-char query (FTS branch, not the <3 fallback)', () => {
    // Query is 3 code points, so isTrigramEligible() is true and this routes
    // through the real `MATCH ... ORDER BY bm25(messages_fts) ASC` SQL path.
    indexMessages(MID, [
      // Low relevance: long doc, single occurrence of the 3-char term.
      msg({
        talkerId: 600,
        msgSeqno: '50',
        msgKey: 'fts-long',
        content: JSON.stringify({ content: `北京市${'其他内容'.repeat(20)}` }),
      }),
      // High relevance: short doc, the 3-char term repeated.
      msg({
        talkerId: 601,
        msgSeqno: '51',
        msgKey: 'fts-short',
        content: JSON.stringify({ content: '北京市北京市北京市' }),
      }),
    ])

    const res = querySearch(MID, { query: '北京市', scope: 'all', limit: 50, offset: 0 })

    expect(res.messageHits.length).toBe(2)
    // bm25 (smaller = better) ranks the short repeated doc first.
    expect(res.messageHits[0].msgKey).toBe('fts-short')
    expect(res.messageHits[1].msgKey).toBe('fts-long')
  })

  it('emits SQL snippet() sentinels on a >=3-char query (FTS branch)', () => {
    // 3 code points -> FTS branch -> snippet(messages_fts, 0, char(1), char(2), ...).
    indexMessages(MID, [
      msg({
        talkerId: 602,
        msgSeqno: '52',
        msgKey: 'fts-snip',
        content: JSON.stringify({ content: '今天天气很好我们去公园散步聊到了人工智能' }),
      }),
    ])

    const res = querySearch(MID, { query: '人工智能', scope: 'all', limit: 50, offset: 0 })

    expect(res.messageHits.length).toBe(1)
    const snippet = res.messageHits[0].snippet
    // The SQL snippet() path wraps the match in the contract sentinels U+0001/U+0002.
    expect(snippet).toContain('\u0001')
    expect(snippet).toContain('\u0002')
    expect(snippet).toContain('人工智能')
  })

  it('does not throw on FTS special characters or empty/whitespace queries', () => {
    indexMessages(MID, [
      msg({ talkerId: 603, msgSeqno: '53', msgKey: 'fts-safe', content: JSON.stringify({ content: '今天天气很好' }) }),
    ])

    // FTS5 operators/wildcards must be neutralised by toFtsMatch, never parsed.
    expect(() => querySearch(MID, { query: '天气 OR x*', scope: 'all', limit: 50, offset: 0 })).not.toThrow()
    const orRes = querySearch(MID, { query: '天气 OR x*', scope: 'all', limit: 50, offset: 0 })
    expect(Array.isArray(orRes.messageHits)).toBe(true)
    expect(Array.isArray(orRes.conversationHits)).toBe(true)
    expect(typeof orRes.total).toBe('number')

    // A lone double-quote must not break the quoted MATCH string.
    expect(() => querySearch(MID, { query: '"', scope: 'all', limit: 50, offset: 0 })).not.toThrow()

    // Empty / whitespace-only queries short-circuit to an empty result.
    const blank = querySearch(MID, { query: '   ', scope: 'all', limit: 50, offset: 0 })
    expect(blank.messageHits).toEqual([])
    expect(blank.conversationHits).toEqual([])
    expect(blank.total).toBe(0)
  })
})

function session(overrides: Partial<BilibiliSession>): BilibiliSession {
  return {
    talker_id: 200,
    session_type: 1,
    at_seqno: 0,
    top_ts: 0,
    group_name: '',
    group_cover: '',
    is_follow: 0,
    is_dnd: 0,
    ack_seqno: 0,
    ack_ts: 0,
    session_ts: 1700000000000000,
    unread_count: 0,
    last_msg: null,
    group_type: 0,
    can_fold: 0,
    status: 0,
    max_seqno: 0,
    new_push_msg: 0,
    setting: 0,
    is_guardian: 0,
    is_intercept: 0,
    is_trust: 0,
    system_msg_type: 0,
    live_status: 0,
    biz_msg_unread_count: 0,
    user_label: null,
    ...overrides,
  } as BilibiliSession
}

describe('querySearch conversation hits', () => {
  beforeEach(async () => {
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
  })

  afterEach(() => {
    closeSearchIndex()
  })

  it('matches sessions by name, talker_id, and last_msg_text', () => {
    indexSessions(MID, [
      session({
        talker_id: 700,
        session_type: 1,
        group_name: '阿强的小屋',
        last_msg: {
          sender_uid: 700,
          receiver_type: 1,
          receiver_id: MID,
          msg_type: 1,
          content: JSON.stringify({ content: '周末一起打球' }),
          msg_seqno: 1,
          timestamp: 100,
          at_uids: null,
          msg_key: 'lm1',
          msg_status: 0,
          notify_code: '',
          msg_source: 0,
        },
      }),
      session({ talker_id: 701, session_type: 1, group_name: '无关会话', last_msg: null }),
    ])

    // Name match
    const byName = querySearch(MID, { query: '阿强', scope: 'all', limit: 50, offset: 0 })
    expect(byName.conversationHits.some(c => c.talkerId === 700)).toBe(true)

    // last_msg_text match
    const byMsg = querySearch(MID, { query: '打球', scope: 'all', limit: 50, offset: 0 })
    expect(byMsg.conversationHits.some(c => c.talkerId === 700)).toBe(true)

    // talker_id numeric match
    const byId = querySearch(MID, { query: '700', scope: 'all', limit: 50, offset: 0 })
    expect(byId.conversationHits.some(c => c.talkerId === 700)).toBe(true)
  })

  it('filters conversation hits by sessionType when provided', () => {
    indexSessions(MID, [
      session({ talker_id: 800, session_type: 1, group_name: '搜索目标用户' }),
      session({ talker_id: 801, session_type: 2, group_name: '搜索目标粉丝团' }),
    ])

    const userOnly = querySearch(MID, { query: '搜索目标', scope: 'all', sessionType: 1, limit: 50, offset: 0 })
    expect(userOnly.conversationHits.every(c => c.sessionType === 1)).toBe(true)
    expect(userOnly.conversationHits.some(c => c.talkerId === 800)).toBe(true)
    expect(userOnly.conversationHits.some(c => c.talkerId === 801)).toBe(false)
  })

  it('caps conversation hits at ~20', () => {
    const sessions: BilibiliSession[] = []
    for (let i = 0; i < 30; i++) {
      sessions.push(session({ talker_id: 900 + i, session_type: 1, group_name: `公共前缀会话${i}` }))
    }
    indexSessions(MID, sessions)

    const res = querySearch(MID, { query: '公共前缀会话', scope: 'all', limit: 50, offset: 0 })
    expect(res.conversationHits.length).toBeLessThanOrEqual(20)
    expect(res.conversationHits.length).toBeGreaterThan(0)
  })
})

describe('querySearch short-query fallback (<3 chars)', () => {
  beforeEach(async () => {
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
  })

  afterEach(() => {
    closeSearchIndex()
  })

  it('matches a 2-char CJK query via LIKE fallback over searchable_text', () => {
    indexMessages(MID, [
      msg({
        talkerId: 1100,
        msgSeqno: '60',
        msgKey: 'k60',
        timestamp: 5000,
        content: JSON.stringify({ content: '我爱北京天安门' }),
      }),
      msg({
        talkerId: 1100,
        msgSeqno: '61',
        msgKey: 'k61',
        timestamp: 5001,
        content: JSON.stringify({ content: '完全无关的句子' }),
      }),
    ])

    const res = querySearch(MID, { query: '北京', scope: 'all', limit: 50, offset: 0 })

    expect(res.messageHits.length).toBe(1)
    expect(res.messageHits[0].msgKey).toBe('k60')
    expect(res.total).toBe(1)
  })

  it('matches a 1-char query via LIKE fallback', () => {
    indexMessages(MID, [
      msg({
        talkerId: 1101,
        msgSeqno: '70',
        msgKey: 'k70',
        timestamp: 6000,
        content: JSON.stringify({ content: '猫' }),
      }),
      msg({
        talkerId: 1101,
        msgSeqno: '71',
        msgKey: 'k71',
        timestamp: 6001,
        content: JSON.stringify({ content: '狗' }),
      }),
    ])

    const res = querySearch(MID, { query: '猫', scope: 'all', limit: 50, offset: 0 })
    expect(res.messageHits.length).toBe(1)
    expect(res.messageHits[0].msgKey).toBe('k70')
  })

  it('fallback respects scope=current talkerId', () => {
    indexMessages(MID, [
      msg({
        talkerId: 1200,
        msgSeqno: '80',
        msgKey: 'k80',
        timestamp: 7000,
        content: JSON.stringify({ content: '红色' }),
      }),
      msg({
        talkerId: 1201,
        msgSeqno: '81',
        msgKey: 'k81',
        timestamp: 7001,
        content: JSON.stringify({ content: '红色' }),
      }),
    ])

    const res = querySearch(MID, { query: '红色', scope: 'current', talkerId: 1200, limit: 50, offset: 0 })
    expect(res.messageHits.length).toBe(1)
    expect(res.messageHits[0].talkerId).toBe(1200)
  })

  it('fallback windows to the most recent 500 rows and excludes older matches', () => {
    const inputs: IndexedMessageInput[] = []
    // 1 old matching row at the very bottom of the recency window.
    inputs.push(
      msg({
        talkerId: 1300,
        msgSeqno: '1',
        msgKey: 'old-match',
        timestamp: 1,
        content: JSON.stringify({ content: '稀有词' }),
      })
    )
    // 500 newer NON-matching rows push the old match out of the recent-500 window.
    for (let i = 0; i < 500; i++) {
      inputs.push(
        msg({
          talkerId: 1300,
          msgSeqno: String(1000 + i),
          msgKey: `filler-${i}`,
          timestamp: 1000 + i,
          content: JSON.stringify({ content: `填充内容${i}` }),
        })
      )
    }
    indexMessages(MID, inputs)

    const res = querySearch(MID, { query: '稀有', scope: 'all', limit: 50, offset: 0 })
    // The only match is older than the 500 most-recent rows, so the bounded
    // fallback window must not return it.
    expect(res.messageHits.length).toBe(0)
  })
})

describe('getIndexStats', () => {
  beforeEach(async () => {
    await initSearchIndex({ dbPath: ':memory:', encryptionKeyHex: 'a'.repeat(64) })
  })

  afterEach(() => {
    closeSearchIndex()
  })

  it('reports per-account message and conversation counts, size, and last update', () => {
    indexMessages(MID, [
      msg({
        talkerId: 200,
        msgSeqno: '10',
        msgKey: 's10',
        timestamp: 100,
        content: JSON.stringify({ content: '消息一' }),
      }),
      msg({
        talkerId: 200,
        msgSeqno: '11',
        msgKey: 's11',
        timestamp: 200,
        content: JSON.stringify({ content: '消息二' }),
      }),
      msg({
        talkerId: 201,
        msgSeqno: '12',
        msgKey: 's12',
        timestamp: 300,
        content: JSON.stringify({ content: '消息三' }),
      }),
    ])
    indexSessions(MID, [
      session({ talker_id: 200, session_type: 1, group_name: '会话甲' }),
      session({ talker_id: 201, session_type: 1, group_name: '会话乙' }),
    ])

    // A second account must not inflate MID's counts.
    indexMessages(9999, [
      msg({
        talkerId: 200,
        msgSeqno: '99',
        msgKey: 'other',
        timestamp: 999,
        content: JSON.stringify({ content: '别的账号' }),
      }),
    ])

    const stats = getIndexStats(MID)

    expect(stats.messageCount).toBe(3)
    expect(stats.conversationCount).toBe(2)
    expect(stats.sizeBytes).toBeGreaterThan(0)
    expect(stats.lastUpdatedAt).not.toBeNull()
    expect(typeof stats.lastUpdatedAt).toBe('number')
  })

  it('returns zero counts for an account with no data', () => {
    const stats = getIndexStats(424242)
    expect(stats.messageCount).toBe(0)
    expect(stats.conversationCount).toBe(0)
    // sizeBytes is whole-DB page size; still > 0 because the DB has schema pages.
    expect(stats.sizeBytes).toBeGreaterThan(0)
    expect(stats.lastUpdatedAt).toBeNull()
  })
})
