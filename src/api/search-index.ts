import { createRequire } from 'node:module'

import { app, safeStorage } from 'electron'

import type { BilibiliSession } from '@/types/bilibili'

import { resolveKeyHex } from '@/api/search-index-key'
import { SCHEMA_SQL, SCHEMA_VERSION } from '@/api/search-index-schema'

// ---------------------------------------------------------------------------
// Native driver (loaded outside Vite's bundle via createRequire — see spec 6.2)
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url)
// Lazily required inside initSearchIndex so importing this module never dlopen()s
// the native binding (keeps unit tests that don't init from needing the build).
type DatabaseCtor = new (path: string, options?: Record<string, unknown>) => DatabaseHandle
interface DatabaseHandle {
  pragma(source: string): unknown
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
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
  const keyHex =
    opts?.encryptionKeyHex ??
    resolveKeyHex(safeStorage, {
      read: () => readKeyBlob(),
      write: (_k, v) => writeKeyBlob(v),
    })

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
export function indexMessages(_mid: number, _messages: IndexedMessageInput[]): void {}
export function indexSessions(_mid: number, _sessions: BilibiliSession[]): void {}
export function clearAccountIndex(_mid: number): void {}
export function querySearch(_mid: number, _params: SearchQueryParams): SearchQueryResult {
  return { conversationHits: [], messageHits: [], total: 0 }
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
