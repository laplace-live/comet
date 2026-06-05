import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

// Load the WASM SQLite engine exactly the way search-index.ts loads it at
// runtime: via createRequire so its sibling dist/node-sqlite3-wasm.wasm resolves
// against node_modules (the package does `__dirname + readFileSync`), bypassing
// Vite's bundler. This proves the pure-CommonJS, no-native-build engine loads
// and provides FTS5 + trigram in plain Node (and, by the same code path, in
// Electron's main process).
const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Database } = require('node-sqlite3-wasm')

describe('node-sqlite3-wasm engine + FTS5 trigram', () => {
  it('loads a modern SQLite build with no native addon', () => {
    const db = new Database(':memory:')
    try {
      const row = db.get('SELECT sqlite_version() AS v') as { v: string }
      expect(typeof row.v).toBe('string')
      // FTS5 + trigram landed long ago; this build ships SQLite 3.53.x.
      expect(row.v.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('creates an fts5 trigram table and MATCHes a CJK substring', () => {
    const db = new Database(':memory:')
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram')")
      const insert = db.prepare('INSERT INTO t(rowid, body) VALUES (?, ?)')
      insert.run([1, '你好世界这是一条中文测试消息'])
      insert.run([2, 'hello world plain ascii row'])
      insert.finalize()

      // trigram needs >=3 chars; '中文测试' is a 4-char CJK substring.
      const cjkHit = db.all('SELECT rowid FROM t WHERE t MATCH ? ORDER BY rank', ['中文测试']) as Array<{
        rowid: number
      }>
      expect(cjkHit.map(r => r.rowid)).toEqual([1])

      // snippet() with the locked sentinels (U+0001 / U+0002) must wrap the match.
      const snip = db.get("SELECT snippet(t, 0, char(1), char(2), '…', 32) AS s FROM t WHERE t MATCH ? LIMIT 1", [
        '中文测试',
      ]) as { s: string }
      expect(snip.s).toContain('')
      expect(snip.s).toContain('')

      // ascii substring still works through trigram.
      const asciiHit = db.all('SELECT rowid FROM t WHERE t MATCH ?', ['plain']) as Array<{ rowid: number }>
      expect(asciiHit.map(r => r.rowid)).toEqual([2])
    } finally {
      db.close()
    }
  })
})
