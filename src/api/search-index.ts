import { createRequire } from 'node:module'
import { app } from 'electron'

import type { BackfillCrawler, CrawlerDeps } from '@/api/backfill-crawler'
import type { ConvCursor } from '@/lib/backfill-cursor'
import type { BilibiliSession } from '@/types/bilibili'

import { extractSearchableText } from '@/lib/search-text'

import { createBackfillCrawler } from '@/api/backfill-crawler'
import { SCHEMA_SQL, SCHEMA_VERSION } from '@/api/search-index-schema'

// ---------------------------------------------------------------------------
// WASM SQLite driver (node-sqlite3-wasm).
//
// Loaded outside Vite's bundle via createRequire so its sibling .wasm file is
// resolved relative to node_modules (the package does `__dirname + readFileSync`
// to load dist/node-sqlite3-wasm.wasm). It is pure CommonJS with a synchronous,
// already-instantiated `Database` constructor, so it loads in BOTH the Electron
// main process and plain Node (vitest) with no native addon / node-gyp build.
//
// Required lazily inside initSearchIndex so merely importing this module never
// instantiates the wasm runtime (keeps unrelated unit tests cheap).
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url)

// --- node-sqlite3-wasm surface (subset we use; see node-sqlite3-wasm.d.ts). ---
type WasmBindValue = number | bigint | string | Uint8Array | boolean | null
type WasmBindValues = WasmBindValue | WasmBindValue[] | Record<string, WasmBindValue>
interface WasmRunResult {
  changes: number
  lastInsertRowid: number | bigint
}
interface WasmStatement {
  run(values?: WasmBindValues): WasmRunResult
  get(values?: WasmBindValues): Record<string, unknown> | null
  all(values?: WasmBindValues): Array<Record<string, unknown>>
  finalize(): void
}
interface WasmDatabase {
  exec(sql: string): void
  prepare(sql: string): WasmStatement
  get(sql: string, values?: WasmBindValues): Record<string, unknown> | null
  close(): void
}
type WasmDatabaseCtor = new (path: string, options?: Record<string, unknown>) => WasmDatabase

// --- Stable internal contract the rest of this module is written against. -----
// (Mirrors a better-sqlite3-style handle; the adapter below maps it onto the
// node-sqlite3-wasm API, which has no .pragma()/.transaction() and requires
// manual Statement.finalize().)
interface PreparedStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
interface DatabaseHandle {
  pragma(source: string): unknown
  exec(sql: string): void
  prepare(sql: string): PreparedStatement
  transaction<T extends (...args: never[]) => unknown>(fn: T): T
  close(): void
}

// ---------------------------------------------------------------------------
// Adapter: wrap a node-sqlite3-wasm `Database` as a `DatabaseHandle`.
//
// Param binding: callers pass either a single plain object (named `@param`
// binding — the existing upsert SQL uses `@named`) or positional varargs (`?`).
// node-sqlite3-wasm wants named keys WITH their `@`/`:`/`$` prefix and positional
// values as an array, so we translate the call shape here.
//
// Statement lifetime: each prepared wrapper re-prepares + finalizes the
// underlying wasm Statement per call. node-sqlite3-wasm requires manual
// finalize() to avoid WASM-heap leaks, and a non-finalized statement left "in
// progress" can block a later COMMIT. Re-prepare-per-call keeps every statement
// leak-free and reusable (the two cached upsert wrappers re-prepare safely on
// the hot path), so there is no per-statement finalize bookkeeping to leak.
// ---------------------------------------------------------------------------
function translateBindings(params: unknown[]): WasmBindValues | undefined {
  if (params.length === 0) return undefined
  const first = params[0]
  // A single plain object (not an array, not null) means named-parameter binding.
  if (params.length === 1 && typeof first === 'object' && first !== null && !Array.isArray(first)) {
    const named: Record<string, WasmBindValue> = {}
    for (const [key, value] of Object.entries(first as Record<string, unknown>)) {
      // node-sqlite3-wasm requires the bind-parameter prefix in the key. Our SQL
      // uses `@name`, and callers pass bare keys, so prefix unprefixed keys.
      const prefixed = /^[@:$]/.test(key) ? key : `@${key}`
      named[prefixed] = value as WasmBindValue
    }
    return named
  }
  // Otherwise: positional varargs -> array.
  return params as WasmBindValue[]
}

function createWasmHandle(wasmDb: WasmDatabase): DatabaseHandle {
  return {
    pragma(source: string): unknown {
      // Use exec() (auto-finalizes internally) for write pragmas. For the read
      // pragmas this module needs a value from, callers go through prepare().get();
      // they aren't routed here, so a plain exec is sufficient.
      wasmDb.exec(`PRAGMA ${source}`)
      return undefined
    },
    exec(sql: string): void {
      wasmDb.exec(sql)
    },
    prepare(sql: string): PreparedStatement {
      return {
        run(...params: unknown[]): unknown {
          const stmt = wasmDb.prepare(sql)
          try {
            return stmt.run(translateBindings(params))
          } finally {
            stmt.finalize()
          }
        },
        get(...params: unknown[]): unknown {
          const stmt = wasmDb.prepare(sql)
          try {
            return stmt.get(translateBindings(params)) ?? undefined
          } finally {
            stmt.finalize()
          }
        },
        all(...params: unknown[]): unknown[] {
          const stmt = wasmDb.prepare(sql)
          try {
            return stmt.all(translateBindings(params))
          } finally {
            stmt.finalize()
          }
        },
      }
    },
    transaction<T extends (...args: never[]) => unknown>(fn: T): T {
      // Single shared handle, synchronous callbacks. BEGIN/COMMIT around fn,
      // ROLLBACK on throw (swallowing any rollback error so the original throws).
      return ((...args: Parameters<T>): ReturnType<T> => {
        wasmDb.exec('BEGIN')
        try {
          const result = fn(...args) as ReturnType<T>
          wasmDb.exec('COMMIT')
          return result
        } catch (err) {
          try {
            wasmDb.exec('ROLLBACK')
          } catch {
            // ignore rollback failure; surface the original error
          }
          throw err
        }
      }) as T
    },
    close(): void {
      wasmDb.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Locked-contract public types (full surface; DB-core implements the open/close/
// upsert/clear functions, sibling tasks implement query + backfill)
// ---------------------------------------------------------------------------
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

export interface SearchQueryParams {
  query: string
  scope: 'current' | 'all'
  sessionType?: number
  talkerId?: number
  limit: number
  offset: number
}

export interface ConversationHit {
  talkerId: number
  sessionType: number
  name: string | null
  snippet: string | null
  sessionTs: string | null
}

export interface MessageHit {
  talkerId: number
  sessionType: number
  msgSeqno: string
  msgKey: string
  senderUid: number | null
  msgType: number | null
  timestamp: number | null
  typeLabel: string | null
  snippet: string
}

export interface SearchQueryResult {
  conversationHits: ConversationHit[]
  messageHits: MessageHit[]
  total: number
}

export interface BackfillStatus {
  state: 'idle' | 'running' | 'paused' | 'done' | 'error'
  processedConversations: number
  totalConversations: number
  indexedMessages: number
  currentTalkerId: number | null
  lastError: string | null
}

export interface IndexStats {
  messageCount: number
  conversationCount: number
  sizeBytes: number
  lastUpdatedAt: number | null
}

export interface InitOptions {
  dbPath?: string
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------
let db: DatabaseHandle | null = null

// Cached upsert statement wrappers (bound to the live `db` handle). These run on
// hot fetch paths, so we build the wrapper once and reuse it; closeSearchIndex()
// resets them to null so a re-init re-binds them to the new handle.
let upsertMsgStmt: PreparedStatement | null = null
let upsertSessionStmt: PreparedStatement | null = null

function getDb(): DatabaseHandle {
  if (!db) throw new Error('search-index: DB not initialized; call initSearchIndex() first')
  return db
}

// Internal accessor used ONLY by tests (src/api/search-index.test.ts).
export function __getDbForTest(): DatabaseHandle {
  return getDb()
}

function runMigrations(handle: DatabaseHandle): void {
  handle.exec(SCHEMA_SQL)
  const current = handle.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }
  if ((current?.v ?? 0) < SCHEMA_VERSION) {
    handle.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, Date.now())
  }
}

/**
 * Open the (plaintext) index DB and run migrations.
 *
 * The DB is a plaintext SQLite file under app.getPath('userData') — at-rest
 * encryption was dropped in the WASM-SQLite migration (no WASM SQLite offers a
 * transparent `PRAGMA key` with a synchronous Node VFS, and FTS requires
 * plaintext text in the index). Tests pass dbPath (':memory:' or a temp file).
 */
export async function initSearchIndex(opts?: InitOptions): Promise<void> {
  if (db) return // already open

  const Database = require('node-sqlite3-wasm').Database as WasmDatabaseCtor

  const dbPath = opts?.dbPath ?? `${app.getPath('userData')}/comet-index.db`

  const handle = createWasmHandle(new Database(dbPath))
  // NOTE: WAL is intentionally NOT enabled. node-sqlite3-wasm's file VFS does not
  // honour `PRAGMA journal_mode = WAL` (it silently falls back to 'delete'), so we
  // keep the default rollback-journal mode rather than issue a no-op pragma.
  handle.pragma('foreign_keys = ON')

  runMigrations(handle)
  db = handle
}

export function closeSearchIndex(): void {
  // Cached wrappers are bound to the live handle; drop them BEFORE closing so a
  // re-init re-prepares against the fresh connection. The wrappers re-prepare +
  // finalize their underlying wasm Statement per call, so there is nothing to
  // finalize here beyond closing the connection itself.
  upsertMsgStmt = null
  upsertSessionStmt = null
  if (db) {
    db.close()
    db = null
  }
}

// ---------------------------------------------------------------------------
// Stubs for sibling tasks (upsert/clear filled in by db-core's next tasks;
// query + backfill by other owners). Present so the module type-checks now.
// ---------------------------------------------------------------------------
// Upsert messages for the given account. Idempotent on (account_mid, talker_id,
// session_type, msg_key). Recalled (msg_status===1) content is excluded from FTS;
// only its [已撤回的消息] label is stored. Fire-and-forget: never throws to caller.
export function indexMessages(mid: number, messages: IndexedMessageInput[]): void {
  try {
    if (!db || messages.length === 0) return
    upsertMsgStmt ??= db.prepare(`
      INSERT INTO messages (
        account_mid, talker_id, session_type, msg_seqno, msg_key,
        sender_uid, msg_type, msg_source, timestamp, msg_status,
        searchable_text, type_label, raw_json
      ) VALUES (
        @account_mid, @talker_id, @session_type, @msg_seqno, @msg_key,
        @sender_uid, @msg_type, @msg_source, @timestamp, @msg_status,
        @searchable_text, @type_label, @raw_json
      )
      ON CONFLICT (account_mid, talker_id, session_type, msg_key) DO UPDATE SET
        msg_seqno       = excluded.msg_seqno,
        sender_uid      = excluded.sender_uid,
        msg_type        = excluded.msg_type,
        msg_source      = excluded.msg_source,
        timestamp       = excluded.timestamp,
        msg_status      = excluded.msg_status,
        searchable_text = excluded.searchable_text,
        type_label      = excluded.type_label,
        raw_json        = excluded.raw_json
    `)
    const stmt = upsertMsgStmt
    // Cursor upsert: record last_indexed_at per conversation so getIndexStats can
    // report lastUpdatedAt. Prepared on the live handle (not cached across re-init).
    const cursorStmt = db.prepare(`
      INSERT INTO conv_cursors (account_mid, talker_id, session_type, last_indexed_at)
      VALUES (@account_mid, @talker_id, @session_type, @last_indexed_at)
      ON CONFLICT (account_mid, talker_id, session_type) DO UPDATE SET
        last_indexed_at = excluded.last_indexed_at
    `)
    const runAll = db.transaction((rows: IndexedMessageInput[]) => {
      const touched = new Map<string, { talkerId: number; sessionType: number }>()
      for (const m of rows) {
        let extracted: { text: string; typeLabel: string | null }
        try {
          extracted = extractSearchableText(m.content ?? '', m.msgType ?? 0, m.msgStatus ?? 0)
        } catch {
          extracted = { text: '', typeLabel: null }
        }
        stmt.run({
          account_mid: mid,
          talker_id: m.talkerId,
          session_type: m.sessionType,
          msg_seqno: String(m.msgSeqno),
          msg_key: String(m.msgKey),
          sender_uid: m.senderUid ?? null,
          msg_type: m.msgType ?? null,
          msg_source: m.msgSource ?? null,
          timestamp: m.timestamp ?? null,
          msg_status: m.msgStatus ?? null,
          // extractSearchableText already excludes recalled text (returns '' + the recall label).
          searchable_text: extracted.text || null,
          type_label: extracted.typeLabel,
          raw_json: m.content ?? null,
        })
        touched.set(`${m.talkerId}:${m.sessionType}`, { talkerId: m.talkerId, sessionType: m.sessionType })
      }
      const now = Date.now()
      for (const { talkerId, sessionType } of touched.values()) {
        cursorStmt.run({
          account_mid: mid,
          talker_id: talkerId,
          session_type: sessionType,
          last_indexed_at: now,
        })
      }
    })
    runAll(messages)
  } catch (err) {
    console.error('search-index: indexMessages failed', err)
  }
}
// Upsert session metadata for offline conversation search. Idempotent on
// (account_mid, talker_id, session_type). Fire-and-forget: never throws.
export function indexSessions(mid: number, sessions: BilibiliSession[]): void {
  try {
    if (!db || sessions.length === 0) return
    upsertSessionStmt ??= db.prepare(`
      INSERT INTO sessions (
        account_mid, talker_id, session_type, name, group_name,
        last_msg_text, session_ts, unread_count
      ) VALUES (
        @account_mid, @talker_id, @session_type, @name, @group_name,
        @last_msg_text, @session_ts, @unread_count
      )
      ON CONFLICT (account_mid, talker_id, session_type) DO UPDATE SET
        group_name    = excluded.group_name,
        last_msg_text = excluded.last_msg_text,
        session_ts    = excluded.session_ts,
        unread_count  = excluded.unread_count
    `)
    const stmt = upsertSessionStmt
    const runAll = db.transaction((rows: BilibiliSession[]) => {
      for (const s of rows) {
        let lastMsgText: string | null = null
        if (s.last_msg) {
          try {
            const e = extractSearchableText(
              s.last_msg.content ?? '',
              s.last_msg.msg_type ?? 0,
              s.last_msg.msg_status ?? 0
            )
            lastMsgText = e.text || e.typeLabel || null
          } catch {
            lastMsgText = null
          }
        }
        stmt.run({
          account_mid: mid,
          talker_id: s.talker_id,
          session_type: s.session_type,
          name: null,
          group_name: s.group_name || null,
          last_msg_text: lastMsgText,
          session_ts: s.session_ts != null ? String(s.session_ts) : null,
          unread_count: s.unread_count ?? null,
        })
      }
    })
    runAll(sessions)
  } catch (err) {
    console.error('search-index: indexSessions failed', err)
  }
}

// Remove all rows for one account (account removal, or rebuild). Deleting from
// messages fires the AFTER DELETE trigger that keeps messages_fts in sync.
export function clearAccountIndex(mid: number): void {
  try {
    if (!db) return
    const handle = getDb()
    const purge = handle.transaction((accountMid: number) => {
      for (const table of ['messages', 'sessions', 'users', 'account_cursors', 'conv_cursors']) {
        handle.prepare(`DELETE FROM ${table} WHERE account_mid = ?`).run(accountMid)
      }
    })
    purge(mid)
  } catch (err) {
    console.error('search-index: clearAccountIndex failed', err)
  }
}
// FTS5 trigram tokenizer cannot index-match queries shorter than 3 characters.
// Count by code points so 1-2 CJK chars (each 1 code point) correctly fall back.
function isTrigramEligible(query: string): boolean {
  return [...query.trim()].length >= 3
}

// Escape an FTS5 MATCH string by wrapping it in double quotes and doubling any
// embedded double quotes, so user punctuation can never be parsed as FTS syntax.
function toFtsMatch(query: string): string {
  return `"${query.trim().replace(/"/g, '""')}"`
}

// Build a snippet for the short-query LIKE fallback (no FTS snippet() available).
// Wraps the first case-insensitive match of `q` in the contract sentinels and
// returns a bounded window of surrounding text. Sentinels: U+0001 / U+0002.
function buildFallbackSnippet(text: string, q: string): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return text.slice(0, 64)
  const ctx = 24
  const start = Math.max(0, idx - ctx)
  const end = Math.min(text.length, idx + q.length + ctx)
  const before = (start > 0 ? '…' : '') + text.slice(start, idx)
  const mid = text.slice(idx, idx + q.length)
  const after = text.slice(idx + q.length, end) + (end < text.length ? '…' : '')
  return `${before}\u0001${mid}\u0002${after}`
}

export function querySearch(mid: number, params: SearchQueryParams): SearchQueryResult {
  if (!db) return { conversationHits: [], messageHits: [], total: 0 }

  const conversationHits: ConversationHit[] = []
  const messageHits: MessageHit[] = []
  let total = 0

  const q = params.query.trim()
  if (q.length === 0) {
    return { conversationHits, messageHits, total }
  }

  const scopeCurrent = params.scope === 'current' && typeof params.talkerId === 'number'

  // Conversation hits: bounded LIKE over sessions.name / group_name / talker_id /
  // last_msg_text. Capped ~20, respects params.sessionType, scoped to account_mid.
  // Runs for all query lengths (does not depend on the trigram >=3-char rule).
  const convLike = `%${q.replace(/[%_\\]/g, '\\$&')}%`
  const convFilterType = typeof params.sessionType === 'number'
  const convSql = `
    SELECT
      talker_id               AS talkerId,
      session_type            AS sessionType,
      COALESCE(name, group_name) AS name,
      last_msg_text           AS snippet,
      session_ts              AS sessionTs
    FROM sessions
    WHERE account_mid = ?
      ${convFilterType ? 'AND session_type = ?' : ''}
      AND (
        name LIKE ? ESCAPE '\\'
        OR group_name LIKE ? ESCAPE '\\'
        OR last_msg_text LIKE ? ESCAPE '\\'
        OR CAST(talker_id AS TEXT) LIKE ? ESCAPE '\\'
      )
    ORDER BY session_ts DESC
    LIMIT 20
  `
  const convArgs: Array<string | number> = convFilterType
    ? [mid, params.sessionType as number, convLike, convLike, convLike, convLike]
    : [mid, convLike, convLike, convLike, convLike]

  const convRows = db.prepare(convSql).all(...convArgs) as Array<{
    talkerId: number
    sessionType: number
    name: string | null
    snippet: string | null
    sessionTs: string | null
  }>

  for (const r of convRows) {
    conversationHits.push({
      talkerId: r.talkerId,
      sessionType: r.sessionType,
      name: r.name,
      snippet: r.snippet,
      sessionTs: r.sessionTs == null ? null : String(r.sessionTs),
    })
  }

  if (isTrigramEligible(q)) {
    const match = toFtsMatch(q)

    // total count (no limit/offset)
    const countSql = `
      SELECT COUNT(*) AS n
      FROM messages_fts
      JOIN messages ON messages.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ?
        AND messages.account_mid = ?
        ${scopeCurrent ? 'AND messages.talker_id = ?' : ''}
    `
    const countArgs: Array<string | number> = scopeCurrent ? [match, mid, params.talkerId as number] : [match, mid]
    const countRow = db.prepare(countSql).get(...countArgs) as { n: number } | undefined
    total = countRow?.n ?? 0

    const hitsSql = `
      SELECT
        messages.talker_id   AS talkerId,
        messages.session_type AS sessionType,
        messages.msg_seqno   AS msgSeqno,
        messages.msg_key     AS msgKey,
        messages.sender_uid  AS senderUid,
        messages.msg_type    AS msgType,
        messages.timestamp   AS timestamp,
        messages.type_label  AS typeLabel,
        snippet(messages_fts, 0, char(1), char(2), '…', 32) AS snippet
      FROM messages_fts
      JOIN messages ON messages.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ?
        AND messages.account_mid = ?
        ${scopeCurrent ? 'AND messages.talker_id = ?' : ''}
      ORDER BY bm25(messages_fts) ASC
      LIMIT ? OFFSET ?
    `
    const hitsArgs: Array<string | number> = scopeCurrent
      ? [match, mid, params.talkerId as number, params.limit, params.offset]
      : [match, mid, params.limit, params.offset]

    const rows = db.prepare(hitsSql).all(...hitsArgs) as Array<{
      talkerId: number
      sessionType: number
      msgSeqno: string
      msgKey: string
      senderUid: number | null
      msgType: number | null
      timestamp: number | null
      typeLabel: string | null
      snippet: string
    }>

    for (const r of rows) {
      messageHits.push({
        talkerId: r.talkerId,
        sessionType: r.sessionType,
        msgSeqno: String(r.msgSeqno),
        msgKey: String(r.msgKey),
        senderUid: r.senderUid,
        msgType: r.msgType,
        timestamp: r.timestamp,
        typeLabel: r.typeLabel,
        snippet: r.snippet,
      })
    }
  } else {
    // Short-query (1-2 char / <3 code points) fallback. Trigram cannot match,
    // so scan a bounded recency window of the most recent 500 rows with LIKE.
    const FALLBACK_WINDOW = 500

    const baseWhere = `
      WHERE account_mid = ?
        ${scopeCurrent ? 'AND talker_id = ?' : ''}
    `
    const windowSql = `
      SELECT
        rowid        AS rowid,
        talker_id    AS talkerId,
        session_type AS sessionType,
        msg_seqno    AS msgSeqno,
        msg_key      AS msgKey,
        sender_uid   AS senderUid,
        msg_type     AS msgType,
        timestamp    AS timestamp,
        type_label   AS typeLabel,
        searchable_text AS searchableText
      FROM messages
      ${baseWhere}
      ORDER BY timestamp DESC
      LIMIT ?
    `
    const windowArgs: Array<string | number> = scopeCurrent
      ? [mid, params.talkerId as number, FALLBACK_WINDOW]
      : [mid, FALLBACK_WINDOW]

    const windowRows = db.prepare(windowSql).all(...windowArgs) as Array<{
      rowid: number
      talkerId: number
      sessionType: number
      msgSeqno: string
      msgKey: string
      senderUid: number | null
      msgType: number | null
      timestamp: number | null
      typeLabel: string | null
      searchableText: string | null
    }>

    const needle = q.toLowerCase()
    const matched = windowRows.filter(
      r => typeof r.searchableText === 'string' && r.searchableText.toLowerCase().includes(needle)
    )

    // Rank by a bm25-style relevance proxy: term frequency normalised by document
    // length (shorter docs with more occurrences rank higher), recency as tiebreak.
    const score = (text: string): number => {
      const lower = text.toLowerCase()
      let count = 0
      let from = lower.indexOf(needle)
      while (from !== -1) {
        count += 1
        from = lower.indexOf(needle, from + needle.length)
      }
      return count / Math.max(1, lower.length)
    }
    matched.sort((a, b) => {
      const sb = score(b.searchableText ?? '') - score(a.searchableText ?? '')
      if (sb !== 0) return sb
      return (b.timestamp ?? 0) - (a.timestamp ?? 0)
    })

    total = matched.length

    for (const r of matched.slice(params.offset, params.offset + params.limit)) {
      messageHits.push({
        talkerId: r.talkerId,
        sessionType: r.sessionType,
        msgSeqno: String(r.msgSeqno),
        msgKey: String(r.msgKey),
        senderUid: r.senderUid,
        msgType: r.msgType,
        timestamp: r.timestamp,
        typeLabel: r.typeLabel,
        snippet: buildFallbackSnippet(r.searchableText ?? '', q),
      })
    }
  }

  return { conversationHits, messageHits, total }
}
// ---------------------------------------------------------------------------
// Backfill crawler wiring
// ---------------------------------------------------------------------------
//
// The crawler needs the in-process Bilibili fetchers, the active-account
// resolver, and a renderer progress broadcaster — all of which live in
// bilibili.ts. Since bilibili.ts already imports this module, importing those
// symbols here statically would create a circular dependency. Instead, main.ts
// injects them once at startup via `configureBackfill()`. The DB-backed cursor
// persistence and the indexers stay local to this module.

type BackfillExternals = Pick<
  CrawlerDeps,
  'getActiveAccountMid' | 'fetchSessions' | 'fetchSessionMsgs' | 'emitProgress'
>

let backfillExternals: BackfillExternals | null = null
let crawler: BackfillCrawler | null = null

/**
 * Inject the network fetchers, active-account resolver, and progress broadcaster
 * the backfill crawler depends on. Called once from main.ts at startup to keep
 * this module free of a static dependency on bilibili.ts (avoids an import cycle).
 */
export function configureBackfill(externals: BackfillExternals): void {
  backfillExternals = externals
  // Force a rebuild on next use so a re-configure (e.g. test harness) takes effect.
  crawler = null
}

// Cursor persistence is on the crawler's hot path. Like indexMessages/indexSessions,
// these swallow DB errors (log + degrade) so a transient failure never throws into the
// crawl loop. A read failure returns undefined (treated as a fresh cursor by the crawler).
function getConvCursorRow(mid: number, key: string): ConvCursor | undefined {
  try {
    const [talkerId, sessionType] = key.split(':').map(Number)
    const row = getDb()
      .prepare(
        `SELECT oldest_seqno, backfill_done, newest_seqno, newest_msg_key
         FROM conv_cursors
         WHERE account_mid = ? AND talker_id = ? AND session_type = ?`
      )
      .get(mid, talkerId, sessionType) as
      | {
          oldest_seqno: string | null
          backfill_done: number
          newest_seqno: string | null
          newest_msg_key: string | null
        }
      | undefined
    if (!row) return undefined
    return {
      oldestSeqno: row.oldest_seqno,
      backfillDone: row.backfill_done === 1,
      newestSeqno: row.newest_seqno,
      newestMsgKey: row.newest_msg_key,
    }
  } catch (err) {
    console.error('search-index: getConvCursor failed', err)
    return undefined
  }
}

function saveConvCursorRow(mid: number, key: string, cursor: ConvCursor): void {
  try {
    const [talkerId, sessionType] = key.split(':').map(Number)
    getDb()
      .prepare(
        `INSERT INTO conv_cursors
           (account_mid, talker_id, session_type, oldest_seqno, backfill_done, newest_seqno, newest_msg_key, last_indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_mid, talker_id, session_type) DO UPDATE SET
           oldest_seqno = excluded.oldest_seqno,
           backfill_done = excluded.backfill_done,
           newest_seqno = COALESCE(excluded.newest_seqno, conv_cursors.newest_seqno),
           newest_msg_key = COALESCE(excluded.newest_msg_key, conv_cursors.newest_msg_key),
           last_indexed_at = excluded.last_indexed_at`
      )
      .run(
        mid,
        talkerId,
        sessionType,
        cursor.oldestSeqno,
        cursor.backfillDone ? 1 : 0,
        cursor.newestSeqno,
        cursor.newestMsgKey,
        Date.now()
      )
  } catch (err) {
    console.error('search-index: saveConvCursor failed', err)
  }
}

function saveAccountCursorRow(mid: number, cursor: { sessionEndTs: string | null; sessionHasMore: boolean }): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO account_cursors (account_mid, session_end_ts, session_has_more, last_full_sweep_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_mid) DO UPDATE SET
           session_end_ts = excluded.session_end_ts,
           session_has_more = excluded.session_has_more,
           last_full_sweep_at = excluded.last_full_sweep_at`
      )
      .run(mid, cursor.sessionEndTs, cursor.sessionHasMore ? 1 : 0, Date.now())
  } catch (err) {
    console.error('search-index: saveAccountCursor failed', err)
  }
}

function jitteredDelay(baseMs: number): number {
  // base 2-4s band centered on baseMs (spec: 2-4s jittered)
  const spread = 1000
  return Math.round(baseMs - spread + Math.random() * (2 * spread))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getCrawler(): BackfillCrawler {
  if (crawler) return crawler
  if (!backfillExternals) {
    throw new Error('search-index: backfill not configured; call configureBackfill() first')
  }
  crawler = createBackfillCrawler({
    getActiveAccountMid: backfillExternals.getActiveAccountMid,
    fetchSessions: backfillExternals.fetchSessions,
    fetchSessionMsgs: backfillExternals.fetchSessionMsgs,
    indexSessions,
    indexMessages,
    getConvCursor: getConvCursorRow,
    saveConvCursor: saveConvCursorRow,
    saveAccountCursor: saveAccountCursorRow,
    emitProgress: backfillExternals.emitProgress,
    sleep,
    jitter: jitteredDelay,
  })
  return crawler
}

export function startBackfill(mid: number, opts?: { sessionType?: number }): void {
  void mid // active account resolved inside the crawler via getActiveAccountMid()
  getCrawler().start(opts)
}

export function pauseBackfill(): void {
  getCrawler().pause()
}

export function resumeBackfill(): void {
  getCrawler().resume()
}

export function getBackfillStatus(): BackfillStatus {
  if (!backfillExternals) {
    // Not yet configured (e.g. index unavailable): report idle rather than throwing.
    return {
      state: 'idle',
      processedConversations: 0,
      totalConversations: 0,
      indexedMessages: 0,
      currentTalkerId: null,
      lastError: null,
    }
  }
  return getCrawler().getStatus()
}
export function getIndexStats(mid: number): IndexStats {
  if (!db) {
    return { messageCount: 0, conversationCount: 0, sizeBytes: 0, lastUpdatedAt: null }
  }

  const msgRow = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_mid = ?').get(mid) as
    | { n: number }
    | undefined
  const convRow = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE account_mid = ?').get(mid) as
    | { n: number }
    | undefined

  const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number } | undefined)?.page_count ?? 0
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number } | undefined)?.page_size ?? 0

  const lastRow = db.prepare('SELECT MAX(last_indexed_at) AS ts FROM conv_cursors WHERE account_mid = ?').get(mid) as
    | { ts: number | null }
    | undefined

  return {
    messageCount: msgRow?.n ?? 0,
    conversationCount: convRow?.n ?? 0,
    sizeBytes: pageCount * pageSize,
    lastUpdatedAt: lastRow?.ts ?? null,
  }
}
