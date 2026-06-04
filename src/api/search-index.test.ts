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
