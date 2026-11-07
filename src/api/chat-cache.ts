import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { safeStorage } from 'electron'

import type { AccountSnapshot, ChatMatch, SavedChat } from '@/lib/account-cache'

import { findMessage } from '@/lib/account-cache'

/**
 * The renderer's account cache, kept on disk between launches unless Settings › 在本机保留聊天记录 is off: each
 * account's session lists, and the chats opened under it. Everything is sealed with safeStorage, as the accounts
 * are, but nothing is written when it can't encrypt: there's no plain text fallback, as this is only a cache, and
 * of private messages.
 *
 *   <dir>/<mid>/lists      the lists as last shown
 *   <dir>/<mid>/chats      the file holding each chat and how many messages it has, least recently used first
 *   <dir>/<mid>/<random>   a chat, named at random so the names say nothing of who it's with
 */

// Bumped whenever what's saved changes shape: anything saved under another version reads as nothing
const VERSION = 1
const LISTS = 'lists'
const CHATS = 'chats'

interface ChatEntry {
  /** The chat's key within its account (chatKey) */
  key: string
  file: string
  /** How many messages it holds */
  size: number
}

export interface ChatCacheOptions {
  /** Where it all goes, made when first written to */
  dir: () => string
  /** The accounts stored now: nothing is saved for another, and what's left of one that's gone is deleted */
  storedMids: () => Promise<number[]>
  /** Messages kept for an account, across its chats; past it, the least recently used chats go */
  budget?: number
}

export interface ChatCacheStore {
  /** An account's lists as last saved, null when there are none */
  loadLists(mid: number): Promise<AccountSnapshot | null>
  saveLists(mid: number, lists: AccountSnapshot): Promise<void>
  /** A chat as last saved, null when there's none */
  loadChat(mid: number, key: string): Promise<SavedChat | null>
  saveChat(mid: number, key: string, chat: SavedChat): Promise<void>
  /** An account's saved chats with a message holding `query`, each with the newest that does (see findMessage) */
  searchChats(mid: number, query: string): Promise<ChatMatch[]>
  /** Delete everything saved of an account, as it signs out or is removed */
  forgetAccount(mid: number): Promise<void>
  /** Delete everything saved */
  clear(): Promise<void>
}

/** Whether safeStorage can seal what's saved: not with Linux's basic_text, whose key is the same everywhere */
async function canSeal(): Promise<boolean> {
  try {
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false
    return await safeStorage.isAsyncEncryptionAvailable()
  } catch {
    return false
  }
}

async function write(file: string, value: unknown): Promise<void> {
  const sealed = await safeStorage.encryptStringAsync(JSON.stringify({ version: VERSION, value }))
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  // Whole or not at all: a write cut short leaves the file as it was, and a stray temporary file to tidy away
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, sealed, { mode: 0o600 })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** A file's value, or null when it's missing or unreadable, which also deletes it */
async function read<T>(file: string): Promise<T | null> {
  let sealed: Buffer
  try {
    sealed = await readFile(file)
  } catch {
    return null
  }
  let value: T
  let reseal: boolean
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(sealed)
    const saved: { version?: number; value?: T } = JSON.parse(result)
    if (saved.version !== VERSION || saved.value === undefined) throw new Error(`Saved as version ${saved.version}`)
    value = saved.value
    reseal = shouldReEncrypt
  } catch (error) {
    console.warn('[chat-cache] Dropped an unreadable file:', path.basename(file), error)
    await rm(file, { force: true })
    return null
  }
  // Sealed with a key safeStorage has since replaced
  if (reseal) await write(file, value).catch(error => console.warn('[chat-cache] Failed to seal a file again:', error))
  return value
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

const isMid = (mid: unknown): mid is number => Number.isSafeInteger(mid) && (mid as number) > 0

export function createChatCacheStore({ dir, storedMids, budget = 50_000 }: ChatCacheOptions): ChatCacheStore {
  const accountDir = (mid: number) => path.join(dir(), String(mid))
  const readIndex = async (mid: number) => (await read<ChatEntry[]>(path.join(accountDir(mid), CHATS))) ?? []
  const isStored = async (mid: number) => (await storedMids()).includes(mid)

  // One thing at a time: a chat's file and the index naming it change together, and a deletion lands after the
  // saves asked for before it
  let queue: Promise<unknown> = Promise.resolve()
  let tidied = false

  /** Run `task` after what's queued; it never throws, settling on `fallback` instead */
  function enqueue<T>(fallback: T, task: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      try {
        if (!tidied && (await canSeal())) {
          tidied = true
          await tidy()
        }
        return await task()
      } catch (error) {
        console.error('[chat-cache]', error)
        return fallback
      }
    })
    queue = result
    return result
  }

  /** Delete what's left of accounts no longer stored, and files no index names, from a crash say: once a launch */
  async function tidy(): Promise<void> {
    const stored = new Set((await storedMids()).map(String))
    // No accounts can also mean they failed to decrypt just now: delete nothing on that
    if (stored.size === 0) return
    for (const name of await list(dir())) {
      if (!stored.has(name)) {
        await rm(path.join(dir(), name), { recursive: true, force: true })
        continue
      }
      const named = new Set([LISTS, CHATS, ...(await readIndex(Number(name))).map(entry => entry.file)])
      for (const file of await list(path.join(dir(), name))) {
        if (!named.has(file)) await rm(path.join(dir(), name, file), { recursive: true, force: true })
      }
    }
  }

  return {
    loadLists: mid =>
      enqueue(null, async () => {
        if (!isMid(mid) || !(await canSeal())) return null
        return read<AccountSnapshot>(path.join(accountDir(mid), LISTS))
      }),

    saveLists: (mid, lists) =>
      enqueue(undefined, async () => {
        if (!isMid(mid) || !(await canSeal()) || !(await isStored(mid))) return
        await write(path.join(accountDir(mid), LISTS), lists)
      }),

    loadChat: (mid, key) =>
      enqueue(null, async () => {
        if (!isMid(mid) || !(await canSeal())) return null
        const index = await readIndex(mid)
        const entry = index.find(e => e.key === key)
        if (!entry) return null
        const chat = await read<SavedChat>(path.join(accountDir(mid), entry.file))
        // Used now, it goes last; unreadable, it leaves the index
        const rest = index.filter(e => e !== entry)
        await write(path.join(accountDir(mid), CHATS), chat ? [...rest, entry] : rest)
        return chat
      }),

    saveChat: (mid, key, chat) =>
      enqueue(undefined, async () => {
        if (!isMid(mid) || typeof key !== 'string' || !(await canSeal()) || !(await isStored(mid))) return
        const index = await readIndex(mid)
        const known = index.find(e => e.key === key)
        const saved: ChatEntry = {
          key,
          file: known?.file ?? randomBytes(16).toString('hex'),
          size: chat.messages.length,
        }
        await write(path.join(accountDir(mid), saved.file), chat)

        // Past the budget, the least recently used chats go, but never the one just saved
        const chats = [...index.filter(e => e !== known), saved]
        let total = chats.reduce((sum, e) => sum + e.size, 0)
        const dropped: ChatEntry[] = []
        for (const entry of chats) {
          if (total <= budget || entry === saved) break
          dropped.push(entry)
          total -= entry.size
        }
        await write(path.join(accountDir(mid), CHATS), chats.slice(dropped.length))
        for (const entry of dropped) await rm(path.join(accountDir(mid), entry.file), { force: true })
      }),

    searchChats: (mid, query) =>
      enqueue<ChatMatch[]>([], async () => {
        if (!isMid(mid) || typeof query !== 'string' || !query.trim() || !(await canSeal())) return []
        const needle = query.trim().toLowerCase()
        const found: ChatMatch[] = []
        // Least recently used first, as the index lists them; the order a search shows them in is the lists'
        for (const entry of await readIndex(mid)) {
          const chat = await read<SavedChat>(path.join(accountDir(mid), entry.file))
          const match = chat && findMessage(chat.messages, needle)
          if (match) found.push({ key: entry.key, ...match })
        }
        return found
      }),

    forgetAccount: mid =>
      enqueue(undefined, async () => {
        if (isMid(mid)) await rm(accountDir(mid), { recursive: true, force: true })
      }),

    clear: () =>
      enqueue(undefined, async () => {
        await rm(dir(), { recursive: true, force: true })
      }),
  }
}
