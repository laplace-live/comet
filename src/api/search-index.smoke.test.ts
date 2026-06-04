import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Load the native addon exactly the way search-index.ts will at runtime,
// bypassing Vite's bundler. This proves the from-source native build works
// in the Node test environment (system Node, not Electron's ABI).
const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3-multiple-ciphers')

describe('better-sqlite3-multiple-ciphers native + FTS5 trigram', () => {
  it('reports a SQLite3MultipleCiphers build via cipher pragma and version function', () => {
    const db = new Database(':memory:')
    try {
      // `cipher` pragma returns the active encryption algorithm; plain
      // better-sqlite3 has no such pragma. A multiple-ciphers build defaults
      // to 'chacha20'.
      const cipherAlgo = db.pragma('cipher', { simple: true })
      expect(typeof cipherAlgo).toBe('string')
      expect((cipherAlgo as string).length).toBeGreaterThan(0)

      // sqlite3mc_version() is a SQL function registered only by the
      // SQLite3MultipleCiphers amalgamation. It returns the version string.
      const row = db.prepare('SELECT sqlite3mc_version() AS v').get() as { v: string }
      expect(typeof row.v).toBe('string')
      expect(row.v).toContain('Multiple Ciphers')
    } finally {
      db.close()
    }
  })

  it('creates an fts5 trigram table and MATCHes a CJK substring', () => {
    const db = new Database(':memory:')
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram')")
      const insert = db.prepare('INSERT INTO t(rowid, body) VALUES (?, ?)')
      insert.run(1, '你好世界这是一条中文测试消息')
      insert.run(2, 'hello world plain ascii row')

      // trigram needs >=3 chars; '中文测试' is a 4-char CJK substring.
      const cjkHit = db.prepare('SELECT rowid FROM t WHERE t MATCH ? ORDER BY rank').all('中文测试') as Array<{
        rowid: number
      }>
      expect(cjkHit.map(r => r.rowid)).toEqual([1])

      // snippet() with the locked sentinels must wrap the match.
      const snip = db
        .prepare("SELECT snippet(t, 0, char(1), char(2), '…', 32) AS s FROM t WHERE t MATCH ? LIMIT 1")
        .get('中文测试') as { s: string }
      expect(snip.s).toContain('')
      expect(snip.s).toContain('')

      // ascii substring still works through trigram.
      const asciiHit = db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all('plain') as Array<{ rowid: number }>
      expect(asciiHit.map(r => r.rowid)).toEqual([2])
    } finally {
      db.close()
    }
  })

  it('encrypts with PRAGMA key and round-trips through a reopened handle', () => {
    const file = path.join(os.tmpdir(), `comet-smoke-${process.pid}-${Date.now()}.db`)
    const keyHex = 'a'.repeat(64) // 32-byte raw key as hex

    const db1 = new Database(file)
    try {
      db1.pragma(`key = "x'${keyHex}'"`)
      db1.exec('CREATE TABLE m (id INTEGER PRIMARY KEY, txt TEXT)')
      db1.prepare('INSERT INTO m(id, txt) VALUES (?, ?)').run(1, '加密测试')
    } finally {
      db1.close()
    }

    const db2 = new Database(file)
    try {
      db2.pragma(`key = "x'${keyHex}'"`)
      const got = db2.prepare('SELECT txt FROM m WHERE id = 1').get() as { txt: string }
      expect(got.txt).toBe('加密测试')
    } finally {
      db2.close()
      fs.rmSync(file, { force: true })
    }
  })
})
