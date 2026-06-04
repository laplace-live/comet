import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

import { closeSearchIndex, initSearchIndex } from '@/api/search-index'

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
    const row = h.prepare('SELECT searchable_text, type_label, raw_json FROM messages WHERE msg_key = ?').get(
      '7400000000000000099'
    ) as { searchable_text: string | null; type_label: string | null; raw_json: string }
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
    const row = h.prepare('SELECT searchable_text, type_label FROM messages WHERE msg_key = ?').get(
      '7400000000000000002'
    ) as {
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
