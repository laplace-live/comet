import { createRequire } from 'node:module'
import { app, safeStorage } from 'electron'

import type { BilibiliSession } from '@/types/bilibili'

import { extractSearchableText } from '@/lib/search-text'

import { resolveKeyHex } from '@/api/search-index-key'
import { SCHEMA_SQL, SCHEMA_VERSION } from '@/api/search-index-schema'

// ---------------------------------------------------------------------------
// Native driver (loaded outside Vite's bundle via createRequire — see spec 6.2)
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url)
// Lazily required inside initSearchIndex so importing this module never dlopen()s
// the native binding (keeps unit tests that don't init from needing the build).
type DatabaseCtor = new (path: string, options?: Record<string, unknown>) => DatabaseHandle
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
  encryptionKeyHex?: string
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------
let db: DatabaseHandle | null = null

// Cached upsert statements (bound to the live `db` handle). These run on hot
// fetch paths, so we prepare once and reuse; closeSearchIndex() resets them to
// null so a re-init re-binds them to the new handle.
let upsertMsgStmt: PreparedStatement | null = null
let upsertSessionStmt: PreparedStatement | null = null

// One-time guard so the degraded-mode (no OS keychain) warning is logged once.
let degradedKeyWarned = false

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
 * Open the encrypted index DB and run migrations.
 * Tests pass dbPath (':memory:' or a temp file) + encryptionKeyHex directly.
 * Production: dbPath = userData/comet-index.db; key from safeStorage via key helper.
 */
export async function initSearchIndex(opts?: InitOptions): Promise<void> {
  if (db) return // already open

  const Database = require('better-sqlite3-multiple-ciphers') as DatabaseCtor

  const dbPath = opts?.dbPath ?? `${app.getPath('userData')}/comet-index.db`
  let keyHex = opts?.encryptionKeyHex
  if (keyHex == null) {
    // Production key-resolution path. When the OS keychain is unavailable
    // (e.g. Linux without a keyring) the key helper falls back to a plaintext
    // (v0:) wrapped blob — warn once that the index key is stored without
    // keychain protection (spec degraded-mode requirement).
    if (!safeStorage.isEncryptionAvailable() && !degradedKeyWarned) {
      degradedKeyWarned = true
      console.warn(
        'search-index: OS keychain encryption is unavailable; the index encryption key will be stored WITHOUT keychain protection (degraded mode).'
      )
    }
    keyHex = resolveKeyHex(safeStorage, {
      read: () => readKeyBlob(),
      write: (_k, v) => writeKeyBlob(v),
    })
  }

  const handle = new Database(dbPath)
  // In-memory/temp DBs (tests only) cannot be keyed — the driver rejects
  // `PRAGMA key` on them, and there is no at-rest file to protect anyway.
  // Production always opens a real file path and is fully encrypted.
  const isInMemory = dbPath === ':memory:' || dbPath === ''
  if (!isInMemory) {
    // Cipher selection + raw key (SQLCipher-compatible) per spec 6.5.
    handle.pragma("cipher='sqlcipher'")
    handle.pragma(`key="x'${keyHex}'"`)
    // Probe to confirm key correctness before use (spec 6.5 step 3).
    handle.prepare('SELECT count(*) AS c FROM sqlite_master').get()
    handle.pragma('journal_mode = WAL')
  }
  handle.pragma('foreign_keys = ON')

  runMigrations(handle)
  db = handle
}

export function closeSearchIndex(): void {
  if (db) {
    db.close()
    db = null
  }
  // Cached statements are bound to the now-closed handle; drop them so a
  // re-init re-prepares against the fresh connection.
  upsertMsgStmt = null
  upsertSessionStmt = null
}

// ---------------------------------------------------------------------------
// Key-blob persistence (production path; userData file). Defined here so the
// production init path is self-contained; tests bypass via injected key.
// ---------------------------------------------------------------------------
function keyBlobPath(): string {
  return `${app.getPath('userData')}/comet-index.key`
}

function readKeyBlob(): string | null {
  try {
    // Lazy fs require keeps this module importable in non-Node-fs contexts.
    const fs = require('node:fs') as typeof import('node:fs')
    return fs.existsSync(keyBlobPath()) ? fs.readFileSync(keyBlobPath(), 'utf-8') : null
  } catch {
    return null
  }
}

function writeKeyBlob(value: string): void {
  const fs = require('node:fs') as typeof import('node:fs')
  fs.writeFileSync(keyBlobPath(), value, 'utf-8')
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
    const runAll = db.transaction((rows: IndexedMessageInput[]) => {
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
  }

  return { conversationHits, messageHits, total }
}
export function startBackfill(_mid: number, _opts?: { sessionType?: number }): void {}
export function pauseBackfill(): void {}
export function resumeBackfill(): void {}
export function getBackfillStatus(): BackfillStatus {
  return {
    state: 'idle',
    processedConversations: 0,
    totalConversations: 0,
    indexedMessages: 0,
    currentTalkerId: null,
    lastError: null,
  }
}
export function getIndexStats(_mid: number): IndexStats {
  return { messageCount: 0, conversationCount: 0, sizeBytes: 0, lastUpdatedAt: null }
}
