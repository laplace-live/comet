import path from 'node:path'
import Database from 'better-sqlite3'
import { app, ipcMain, safeStorage } from 'electron'

import type { BilibiliMessage } from '@/types/bilibili'
import type { CacheClearAccountParams, CacheLoadMessagesParams, CacheSaveMessagesParams } from '@/types/electron'

import { IpcChannel } from '@/lib/ipc'

// ============================================================================
// Database Initialization
// ============================================================================

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (db) return db

  const dbPath = path.join(app.getPath('userData'), 'messages.db')
  db = new Database(dbPath)

  // Enable WAL mode for better concurrent read/write performance
  db.pragma('journal_mode = WAL')

  // Create tables and indexes
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      account_mid INTEGER NOT NULL,
      talker_id INTEGER NOT NULL,
      session_type INTEGER NOT NULL,
      msg_key TEXT NOT NULL,
      msg_seqno INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      encrypted_data BLOB NOT NULL,
      PRIMARY KEY (account_mid, msg_key)
    );
    CREATE INDEX IF NOT EXISTS idx_session
      ON messages(account_mid, talker_id, session_type, timestamp);
  `)

  return db
}

// ============================================================================
// Encryption Helpers (matching bilibili.ts pattern)
// ============================================================================

function encryptMessage(message: BilibiliMessage): Buffer {
  const jsonString = JSON.stringify(message)
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(jsonString)
  }
  // Fallback to unencrypted storage if safeStorage is not available
  console.warn('[MessageStore] safeStorage not available, storing data unencrypted')
  return Buffer.from(jsonString, 'utf-8')
}

function decryptMessage(encrypted: Buffer): BilibiliMessage | null {
  try {
    let jsonString: string
    if (safeStorage.isEncryptionAvailable()) {
      jsonString = safeStorage.decryptString(encrypted)
    } else {
      jsonString = encrypted.toString('utf-8')
    }
    return JSON.parse(jsonString)
  } catch (error) {
    console.error('[MessageStore] Failed to decrypt message:', error)
    return null
  }
}

// ============================================================================
// Database Operations
// ============================================================================

function saveMessages(accountMid: number, talkerId: number, sessionType: number, messages: BilibiliMessage[]): void {
  const database = getDb()

  const insertStmt = database.prepare(`
    INSERT OR REPLACE INTO messages (account_mid, talker_id, session_type, msg_key, msg_seqno, timestamp, encrypted_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const insertMany = database.transaction((msgs: BilibiliMessage[]) => {
    for (const msg of msgs) {
      const encryptedData = encryptMessage(msg)
      insertStmt.run(
        accountMid,
        talkerId,
        sessionType,
        String(msg.msg_key),
        msg.msg_seqno,
        msg.timestamp,
        encryptedData
      )
    }
  })

  insertMany(messages)
}

function loadMessages(accountMid: number, talkerId: number, sessionType: number): BilibiliMessage[] {
  const database = getDb()

  const rows = database
    .prepare(
      `SELECT encrypted_data FROM messages
     WHERE account_mid = ? AND talker_id = ? AND session_type = ?
     ORDER BY timestamp ASC`
    )
    .all(accountMid, talkerId, sessionType) as { encrypted_data: Buffer }[]

  const messages: BilibiliMessage[] = []
  for (const row of rows) {
    const msg = decryptMessage(row.encrypted_data)
    if (msg) {
      messages.push(msg)
    }
  }

  return messages
}

function clearAccountMessages(accountMid: number): void {
  const database = getDb()
  database.prepare('DELETE FROM messages WHERE account_mid = ?').run(accountMid)
}

function clearAllMessages(): void {
  const database = getDb()
  database.prepare('DELETE FROM messages').run()
}

// ============================================================================
// IPC Handler Registration
// ============================================================================

export function registerMessageStoreHandlers(): void {
  ipcMain.handle(IpcChannel.BILIBILI_CACHE_SAVE_MESSAGES, async (_event, params: CacheSaveMessagesParams) => {
    try {
      saveMessages(params.accountMid, params.talkerId, params.sessionType, params.messages)
      return { success: true }
    } catch (error) {
      console.error('[MessageStore] Failed to save messages:', error)
      return { success: false }
    }
  })

  ipcMain.handle(IpcChannel.BILIBILI_CACHE_LOAD_MESSAGES, async (_event, params: CacheLoadMessagesParams) => {
    try {
      return loadMessages(params.accountMid, params.talkerId, params.sessionType)
    } catch (error) {
      console.error('[MessageStore] Failed to load messages:', error)
      return []
    }
  })

  ipcMain.handle(IpcChannel.BILIBILI_CACHE_CLEAR_ACCOUNT, async (_event, params: CacheClearAccountParams) => {
    try {
      clearAccountMessages(params.accountMid)
      return { success: true }
    } catch (error) {
      console.error('[MessageStore] Failed to clear account messages:', error)
      return { success: false }
    }
  })

  ipcMain.handle(IpcChannel.BILIBILI_CACHE_CLEAR_ALL, async () => {
    try {
      clearAllMessages()
      return { success: true }
    } catch (error) {
      console.error('[MessageStore] Failed to clear all messages:', error)
      return { success: false }
    }
  })
}

// ============================================================================
// Cleanup
// ============================================================================

export function closeMessageStore(): void {
  if (db) {
    db.close()
    db = null
  }
}
