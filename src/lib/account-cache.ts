import type { UserCache } from '@/lib/message-utils'
import type { BilibiliEmojiInfo, BilibiliMessage, BilibiliSession } from '@/types/bilibili'

import { MSG_TYPE } from '@/types/bilibili'

import { parseMessageContent } from '@/lib/message-utils'

// What each account last showed, so switching to an account, opening a chat again or relaunching shows it at once
// while what's new loads behind it. Kept in memory, and on disk sealed with safeStorage (src/api/chat-cache.ts)
// unless Settings › 在本机保留聊天记录 is off.

/** An account's session lists as last shown, or as loaded in the background before it was ever shown */
export interface AccountSnapshot {
  /** The main list, as many pages as were loaded */
  sessions: BilibiliSession[]
  hasMoreSessions: boolean
  /** Where the main list's next page starts */
  nextEndTs: number | null
  /** 收起未关注人消息, null when it couldn't be read */
  unfollowFold: boolean | null
  /** 未关注人消息's chats while the setting folds them, as many pages as were loaded */
  unfollowed: BilibiliSession[]
  unfollowedUnread: number
  hasMoreUnfollowed: boolean
  unfollowedNextEndTs: number | null
  /** Names and faces of the people in those lists */
  userCache: UserCache
}

// Map of emoji text (e.g., "[tv_doge]") to emoji info
export type EmojiInfoMap = Record<string, BilibiliEmojiInfo>

/** A conversation as last shown */
export interface CachedChat {
  /** Oldest first */
  messages: BilibiliMessage[]
  emojiInfoMap: EmojiInfoMap
  /**
   * The seqno up to which `messages` holds every message, where loading what's new starts. Messages that came
   * over the WebSocket since can be newer, with others missing in between.
   */
  syncedSeqno: number
}

/** A chat as saved on disk, with the names of the people who wrote in it, which its account's lists may not hold */
export interface SavedChat extends CachedChat {
  users: UserCache
}

/** A chat's key within an account. Two accounts can talk to the same user, so the cache keys by account too. */
export function chatKey(session: Pick<BilibiliSession, 'session_type' | 'talker_id'>): string {
  return `${session.session_type}:${session.talker_id}`
}

/** The session_ts of a list's last session, where its next page starts; null when it has none */
export function lastSessionTs(list: BilibiliSession[]): number | null {
  return list.length > 0 ? list[list.length - 1].session_ts : null
}

/** How many sessions of each list are saved on disk; past them, the lists load as they scroll, as on a first launch */
export const SAVED_SESSIONS = 200

/**
 * An account's lists as saved on disk: the first `SAVED_SESSIONS` of each, going on from where they stop, and the
 * names of the people in them
 */
export function listsToSave(snapshot: AccountSnapshot): AccountSnapshot {
  const sessions = snapshot.sessions.slice(0, SAVED_SESSIONS)
  const unfollowed = snapshot.unfollowed.slice(0, SAVED_SESSIONS)
  const talkers = new Set([...sessions, ...unfollowed].map(s => s.talker_id))
  const saved: AccountSnapshot = {
    ...snapshot,
    sessions,
    unfollowed,
    userCache: Object.fromEntries(Object.entries(snapshot.userCache).filter(([uid]) => talkers.has(Number(uid)))),
  }
  if (sessions.length < snapshot.sessions.length) {
    saved.hasMoreSessions = true
    saved.nextEndTs = lastSessionTs(sessions)
  }
  if (unfollowed.length < snapshot.unfollowed.length) {
    saved.hasMoreUnfollowed = true
    saved.unfollowedNextEndTs = lastSessionTs(unfollowed)
  }
  return saved
}

/** A chat to save on disk, with the names its messages' senders have in `userCache` */
export function chatToSave(chat: CachedChat, userCache: UserCache): SavedChat {
  const users: UserCache = {}
  for (const { sender_uid: uid } of chat.messages) {
    if (userCache[uid]) users[uid] = userCache[uid]
  }
  return { ...chat, users }
}

/** A message a search found a chat by: its msg_key, which the chat opens at, and what it says as the chat shows it */
export interface MessageMatch {
  msgKey: string
  text: string
}

/** A chat a search finds by a message it holds: its key (chatKey), and that message */
export interface ChatMatch extends MessageMatch {
  key: string
}

const keyOf = (message: BilibiliMessage) => String(message.msg_key)

/**
 * The newest of a chat's messages that holds `query`, null when none does. Search looks through the messages of the
 * chats held here or on disk this way, as Bilibili has no search to ask, and finds a chat by any of them, not just
 * its last. A recalled message shows as recalled, so what it said doesn't count.
 * @param query - lowercase
 */
export function findMessage(messages: BilibiliMessage[], query: string): MessageMatch | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.msg_status || message.msg_type === MSG_TYPE.REVOKE) continue
    const text = parseMessageContent(message)
    if (text.toLowerCase().includes(query)) return { msgKey: keyOf(message), text }
  }
  return null
}

/**
 * A session list with its first page fetched again laid over it, keeping the pages loaded past that when they still
 * follow on from it; null when they don't, and the fresh page should replace the list.
 *
 * Bilibili lists sessions newest first, and a chat with a new message moves to the top. So every chat that changed
 * since `list` loaded sorts above all of `list`, and when the fresh page reaches back as far as the newest of `list`,
 * it holds them all: the older sessions held past the page's end are still in order, and the list's next page
 * still starts where it did. Like Bilibili's web client, this leaves those older rows as they were (an unread
 * count read away on another device, say) until a full reload.
 * @param pageHasMore - whether the list goes on past the fresh page
 */
export function keepLoadedPages(
  list: BilibiliSession[],
  page: BilibiliSession[],
  pageHasMore: boolean
): BilibiliSession[] | null {
  if (!pageHasMore || page.length === 0) return null

  const onPage = new Set(page.map(chatKey))
  // A pinned chat the page leaves out was unpinned since, and its place among the older ones isn't known
  if (list.some(s => s.top_ts > 0 && !onPage.has(chatKey(s)))) return null

  const pageEnd = page[page.length - 1].session_ts
  const newestHeld = list.reduce((newest, s) => Math.max(newest, s.session_ts), 0)
  if (pageEnd > newestHeld) return null

  // Older than the page's end, where the next page starts; anything newer not on it isn't listed anymore
  const older = list.filter(s => s.session_ts < pageEnd && !onPage.has(chatKey(s)))
  return older.length > 0 ? [...page, ...older] : null
}

/** The newest seqno among messages, or `floor` when none is newer */
export function newestSeqno(messages: BilibiliMessage[], floor = 0): number {
  return messages.reduce((max, m) => Math.max(max, m.msg_seqno), floor)
}

/**
 * A conversation with newer messages merged in by msg_key, oldest first. A message held already takes the newer
 * copy where that differs (the server's copy of one sent from here, say), and a recall marks the message it
 * recalls, as loading the chat again would show it.
 * @returns `held` itself when nothing changed
 */
export function mergeMessages(held: BilibiliMessage[], newer: BilibiliMessage[]): BilibiliMessage[] {
  const byKey = new Map(held.map(m => [keyOf(m), m]))
  let changed = false
  for (const message of newer) {
    const same = byKey.get(keyOf(message))
    if (
      same &&
      same.content === message.content &&
      same.msg_status === message.msg_status &&
      same.msg_seqno === message.msg_seqno
    ) {
      continue
    }
    byKey.set(keyOf(message), message)
    changed = true
  }

  // A recall (msg_type 5) carries the msg_key of the message it takes back. Bilibili removes one it cancelled itself
  // (sys_cancel) and marks the rest recalled, as the web client shows them.
  for (const message of newer) {
    if (message.msg_type !== MSG_TYPE.REVOKE) continue
    const key = String(message.content).trim()
    const recalled = byKey.get(key)
    if (!recalled) continue
    if (message.sys_cancel) {
      byKey.delete(key)
      changed = true
    } else if (recalled.msg_status === 0) {
      byKey.set(key, { ...recalled, msg_status: 1 })
      changed = true
    }
  }

  if (!changed) return held
  // Seqnos break ties within a second. A message sent from here holds a stand-in seqno until the server's copy
  // replaces it, which only matters within that second.
  return [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp || a.msg_seqno - b.msg_seqno)
}

/**
 * The conversations of every account signed in since launch, least recently opened first, dropped from there
 * once they hold more than `budget` messages between them (the one just stored stays, however long)
 */
export class ChatCache {
  private readonly chats = new Map<string, CachedChat>()
  private size = 0

  constructor(private readonly budget: number) {}

  get(mid: number, key: string): CachedChat | undefined {
    const id = `${mid}/${key}`
    const chat = this.chats.get(id)
    if (!chat) return undefined
    this.chats.delete(id)
    this.chats.set(id, chat)
    return chat
  }

  set(mid: number, key: string, chat: CachedChat): void {
    const id = `${mid}/${key}`
    this.remove(id)
    this.chats.set(id, chat)
    this.size += chat.messages.length
    for (const [other] of this.chats) {
      if (this.size <= this.budget || other === id) break
      this.remove(other)
    }
  }

  /** An account's conversations by their keys (chatKey), leaving their order as it is */
  chatsOf(mid: number): Array<[string, CachedChat]> {
    const prefix = `${mid}/`
    return [...this.chats]
      .filter(([id]) => id.startsWith(prefix))
      .map(([id, chat]): [string, CachedChat] => [id.slice(prefix.length), chat])
  }

  /** Forget an account's conversations, as it signs out or is removed */
  forgetAccount(mid: number): void {
    for (const id of [...this.chats.keys()]) {
      if (id.startsWith(`${mid}/`)) this.remove(id)
    }
  }

  private remove(id: string): void {
    const chat = this.chats.get(id)
    if (!chat) return
    this.chats.delete(id)
    this.size -= chat.messages.length
  }
}
