import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AccountSnapshot, CachedChat, EmojiInfoMap, MessageMatch, SavedChat } from '@/lib/account-cache'
import type { UserCache } from '@/lib/message-utils'
import type {
  BilibiliEmojiInfo,
  BilibiliMessage,
  BilibiliSession,
  BilibiliSessionsResponse,
  CustomerServiceMessage,
  CustomerServiceMessagesResponse,
  CustomerServiceSession,
} from '@/types/bilibili'
import type {
  CheckLoginResult,
  CustomerServiceShop,
  ErrorResponse,
  GetAccountsResult,
  NavigateToSessionParams,
  NewMessageNotification,
  SessionUpdateNotification,
  StoredAccountInfo,
} from '@/types/electron'

import {
  CS_MSG_TYPE,
  CS_SENDER_TYPE,
  CUSTOMER_SERVICE_WS_SESSION_TYPES,
  SESSION_LIST_TYPE,
  SESSION_TYPE,
} from '@/types/bilibili'

import {
  ChatCache,
  chatKey,
  chatToSave,
  findMessage,
  keepLoadedPages,
  lastSessionTs,
  listsToSave,
  mergeMessages,
  newestSeqno,
} from '@/lib/account-cache'
import { getImageType } from '@/lib/const'
import {
  type CustomerServiceReply,
  getCustomerServicePreview,
  getCustomerServiceShop,
  getNotifiedShop,
  isEarlierSeqno,
  isSameShop,
  mergeCustomerServiceMessages,
  toDisplayMessage,
} from '@/lib/customer-service'
import {
  getSessionAvatar,
  getSessionName,
  isCustomerServiceSession,
  isUnfollowedChat,
  parseMessageContent,
} from '@/lib/message-utils'

import { toastManager } from '@/components/ui/toast'

import { useDrafts } from '@/stores/useDrafts'
import { useSettings } from '@/stores/useSettings'

// Helper to check if response is an error
function isErrorResponse<T extends object>(response: T | ErrorResponse): response is ErrorResponse {
  return 'error' in response
}

// Whether a session is this chat
function isSameChat(session: BilibiliSession | null | undefined, chat: BilibiliSession): boolean {
  return session?.talker_id === chat.talker_id && session?.session_type === chat.session_type
}

// Who a stored account is, shown signed in while its login is checked
function storedLogin(account: StoredAccountInfo): CheckLoginResult {
  return { isLogin: true, mid: account.mid, uname: account.uname, face: account.face }
}

/**
 * Whether a session list goes on past its first page. Bilibili picks the first page of a list it filters
 * (未关注人消息, or the main list with those chats folded out of it) from the account's newest hundred or so chats,
 * and says has_more 0 once they run out, though older ones follow. So a first page like that goes on if it lists
 * any, and the page asked from its last row tells: has_more holds for a page asked from where another ended.
 * @param filtered - whether the list leaves chats out: 未关注人消息, or the main list while it folds them away
 */
function firstPageGoesOn(page: BilibiliSessionsResponse, filtered: boolean): boolean {
  return page.data?.has_more === 1 || (filtered && (page.data?.session_list?.length ?? 0) > 0)
}

/** A read or write of the cache on disk, which failing never stops anything: it reads as nothing */
async function quietly<T>(what: string, task: () => Promise<T>): Promise<T | null> {
  try {
    return await task()
  } catch (err) {
    console.warn(`[usePrivateMessages] Failed to ${what}:`, err)
    return null
  }
}

/** Messages as fetched, newest first, with the emoji they use */
interface FetchedMessages {
  messages: BilibiliMessage[]
  emojiInfos: BilibiliEmojiInfo[]
}

// Show the local 客服消息 mute as is_dnd, so it reads like any other muted session
function withLocalDnd(session: BilibiliSession): BilibiliSession {
  return isCustomerServiceSession(session) ? { ...session, is_dnd: 1 } : session
}

const NO_CUSTOMER_SERVICE_CHAT = '暂无可回复的客服会话'

interface CustomerServicePages {
  /** Newest first, as the pages come */
  messages: CustomerServiceMessage[]
  emojiInfos: BilibiliEmojiInfo[]
  /** Why paging stopped early, if a page failed */
  error: string | null
}

/**
 * Page back through a customer service chat, newest first, each page continuing from the oldest seqno
 * of the last, until `enough` says so or the history runs out
 * @param stale - checked after every page, so a load the user has moved on from stops there
 * @returns null when it went stale
 */
async function fetchCustomerServicePages(
  shop: CustomerServiceShop,
  enough: (page: CustomerServiceMessage[]) => boolean,
  stale: () => boolean
): Promise<CustomerServicePages | null> {
  const pages: CustomerServicePages = { messages: [], emojiInfos: [], error: null }
  let endSeqno: string | undefined

  for (;;) {
    let data: CustomerServiceMessagesResponse | ErrorResponse
    try {
      data = await window.electronAPI.bilibili.customerService.fetchMessages({ ...shop, endSeqno })
    } catch (err) {
      if (stale()) return null
      return { ...pages, error: err instanceof Error ? err.message : 'Failed to fetch customer service messages' }
    }
    if (stale()) return null
    if (isErrorResponse(data) || data.code !== 0 || !data.data) {
      const error = isErrorResponse(data) ? data.error : data.message
      return { ...pages, error: error || 'Failed to fetch customer service messages' }
    }

    const page = data.data.messages || []
    pages.messages.push(...page)
    pages.emojiInfos.push(...(data.data.e_infos || []))
    const more = data.data.has_more === 1 && page.length > 0 && isEarlierSeqno(data.data.min_seqno, endSeqno)
    if (!more || enough(page)) return pages
    endSeqno = data.data.min_seqno
  }
}

export type { EmojiInfoMap }

// How many messages the conversations kept from earlier, across all accounts, hold at most between them
const CHAT_CACHE_BUDGET = 50_000
// How long the lists or a chat stay unchanged before they're saved on disk, so a busy chat isn't written every message
const SAVE_DELAY = 2000
// Messages per page, large to need few requests
const MESSAGES_PAGE_SIZE = '1000'

/**
 * A message the open chat opened at instead of its newest: the one a search found it by. Each opening has an `id`
 * of its own, so opening it at the same message again goes back there.
 */
export interface TargetMessage {
  msgKey: string
  id: number
}

/** 未关注人消息: the chats 收起未关注人消息 folds out of the main list, listed apart from it */
export interface UnfollowedFold {
  /** Newest first, as Bilibili pages them */
  sessions: BilibiliSession[]
  /** Unread across all of them, loaded or not, as Bilibili counts it */
  unread: number
  hasMore: boolean
  loadingMore: boolean
  /** Whether the session list shows these chats (未关注的人) instead of the main list */
  open: boolean
}

/** A first page of 未关注人消息 as fetched, with its unread, null when only that failed to load */
interface UnfollowedPage {
  sessions: BilibiliSession[]
  hasMore: boolean
  unread: number | null
}

export interface UsePrivateMessagesReturn {
  // State
  sessions: BilibiliSession[]
  selectedSession: BilibiliSession | null
  /** Where the open chat opened, when not at its newest message */
  targetMessage: TargetMessage | null
  messages: BilibiliMessage[]
  emojiInfoMap: EmojiInfoMap
  loading: boolean
  loadingMore: boolean
  messagesLoading: boolean
  sendingMessage: boolean
  error: string | null
  isConnected: boolean
  /** Until launch has found who's signed in, or shows the account saved from last time while it checks */
  initializing: boolean
  userCache: UserCache
  hasMoreSessions: boolean
  userInfo: CheckLoginResult | null
  wsConnected: boolean

  // Multi-account state
  accounts: StoredAccountInfo[]
  activeAccountMid: number | null
  isAddingAccount: boolean
  reauthAccount: StoredAccountInfo | null

  // Customer service chats shown in 客服消息, one per shop
  customerServiceSessions: CustomerServiceSession[]
  activeCustomerService: CustomerServiceSession | null
  selectCustomerService: (shop: CustomerServiceShop) => void
  sendCustomerServiceReply: (reply: CustomerServiceReply) => Promise<boolean>

  // 收起未关注人消息, the account's setting on Bilibili (null until read), and 未关注人消息 while it's on
  unfollowFold: boolean | null
  unfollowed: UnfollowedFold | null
  toggleUnfollowFold: (enabled: boolean) => Promise<boolean>
  openUnfollowed: () => void
  closeUnfollowed: () => void
  loadMoreUnfollowed: () => Promise<void>
  /**
   * The shown account's chats with a message holding `query`, by chat key, each with the newest that does, as the
   * chats opened before hold them (see searchHeldChats)
   */
  searchHeldChats: (query: string) => Promise<Map<string, MessageMatch>>

  // Actions
  checkLogin: () => Promise<boolean>
  logout: () => Promise<void>
  fetchSessions: () => Promise<void>
  loadMoreSessions: () => Promise<void>
  fetchMessages: (session: BilibiliSession) => Promise<void>
  /** Open a chat, at its newest message or at the one with `msgKey` (a search result's) */
  selectSession: (session: BilibiliSession, msgKey?: string) => void
  clearSelectedSession: () => void
  sendMessage: (content: string) => Promise<boolean>
  sendImageMessage: (imageData: string, mimeType: string) => Promise<boolean>
  recallMessage: (msgSeqno: number, msgKeyStr: string) => Promise<{ success: boolean; error?: string }>
  toggleDnd: (session: BilibiliSession, enabled: boolean) => Promise<boolean>
  toggleSticky: (session: BilibiliSession, pinned: boolean) => Promise<boolean>
  connectWebSocket: () => Promise<void>
  disconnectWebSocket: () => Promise<void>

  // Multi-account actions
  /** Fetch all stored accounts, resolving to them, or to null when that fails */
  fetchAccounts: () => Promise<GetAccountsResult | null>
  switchAccount: (mid: number) => Promise<void>
  removeAccount: (mid: number) => Promise<void>
  reorderAccounts: (mids: number[]) => Promise<boolean>
  startAddingAccount: () => void
  cancelAddingAccount: () => void
  onAccountAdded: () => Promise<void>
  startReauthAccount: (mid: number) => void
  cancelReauthAccount: () => void
  onReauthSuccess: () => Promise<void>
}

export function usePrivateMessages(): UsePrivateMessagesReturn {
  const [sessions, setSessions] = useState<BilibiliSession[]>([])
  const [selectedSession, setSelectedSession] = useState<BilibiliSession | null>(null)
  const [targetMessage, setTargetMessage] = useState<TargetMessage | null>(null)
  const targetIdRef = useRef(0)
  const [messages, setMessages] = useState<BilibiliMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [sendingMessage, setSendingMessage] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  // Until launch has found who's signed in, or shows the account saved from last time while it checks
  const [initializing, setInitializing] = useState(true)
  const [userCache, setUserCache] = useState<UserCache>({})
  const [hasMoreSessions, setHasMoreSessions] = useState(false)
  const [nextEndTs, setNextEndTs] = useState<number | null>(null)
  const [userInfo, setUserInfo] = useState<CheckLoginResult | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [emojiInfoMap, setEmojiInfoMap] = useState<EmojiInfoMap>({})
  // Whether an account's lists are loading with nothing of theirs to show meanwhile, after a switch, say
  const [listsPending, setListsPending] = useState(false)

  // Multi-account state
  const [accounts, setAccounts] = useState<StoredAccountInfo[]>([])
  const [activeAccountMid, setActiveAccountMid] = useState<number | null>(null)
  const [isAddingAccount, setIsAddingAccount] = useState(false)
  const [reauthAccount, setReauthAccount] = useState<StoredAccountInfo | null>(null)
  // Kept in step with the state, for callbacks that look accounts up
  const accountsRef = useRef<StoredAccountInfo[]>([])

  // Each account's lists as last shown, or loaded in the background ahead of a switch, and each account's
  // conversations as last shown, in memory. With 在本机保留聊天记录 on, they're saved on disk too (sealed by the main
  // process), so a relaunch shows them at once.
  const [snapshots] = useState(() => new Map<number, AccountSnapshot>())
  const [chatCache] = useState(() => new ChatCache(CHAT_CACHE_BUDGET))
  const keepOnDevice = useSettings(state => state.keepChatsOnDevice)
  // Saves on disk waiting out SAVE_DELAY: the shown lists', and the open chat's
  const listsSaveRef = useRef<{
    mid: number
    snapshot: AccountSnapshot
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  const chatSaveRef = useRef<{
    mid: number
    key: string
    chat: SavedChat
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  // The versions of chats on disk already (by their messages, which change as a whole), so they aren't written again
  const savedChatsRef = useRef(
    new WeakMap<BilibiliMessage[], { id: string; emojiInfoMap: EmojiInfoMap; syncedSeqno: number }>()
  )
  // Accounts whose lists were loaded in the background since launch, or tried: one that failed (its cookies are
  // out of date, say) isn't tried again, and loads when switched to
  const [warmedUp] = useState(() => new Set<number>())
  // The account whose lists the state holds, null while none does. During a switch that's the account switched to,
  // though its login isn't checked yet.
  const shownMidRef = useRef<number | null>(null)
  // Whether the state holds that account's lists yet, loaded or shown from a snapshot
  const listsShownRef = useRef(false)
  // The seqno up to which the open chat's messages hold every message, where catching it up starts
  const syncedSeqnoRef = useRef(0)
  // Cleared on unmount, so background work stops asking the main process for anything
  const mountedRef = useRef(true)

  // Customer service chats, which 客服消息 shows one at a time
  const [customerServiceSessions, setCustomerServiceSessions] = useState<CustomerServiceSession[]>([])
  const [activeCustomerServiceShop, setActiveCustomerServiceShop] = useState<CustomerServiceShop | null>(null)
  const activeCustomerService = useMemo(
    () => customerServiceSessions.find(s => isSameShop(getCustomerServiceShop(s), activeCustomerServiceShop)) ?? null,
    [customerServiceSessions, activeCustomerServiceShop]
  )

  const customerServiceMuted = useSettings(
    state => userInfo?.mid !== undefined && state.customerServiceMutedMids.includes(userInfo.mid)
  )
  const displayedSessions = useMemo(
    () => (customerServiceMuted ? sessions.map(withLocalDnd) : sessions),
    [sessions, customerServiceMuted]
  )
  const displayedSelectedSession = useMemo(
    () => (customerServiceMuted && selectedSession ? withLocalDnd(selectedSession) : selectedSession),
    [selectedSession, customerServiceMuted]
  )

  // 收起未关注人消息, the account's own setting on Bilibili, null until read. With it on, chats with people the
  // user doesn't follow leave the main list for 未关注人消息, which lists them apart, as Bilibili's web client does.
  const [unfollowFold, setUnfollowFold] = useState<boolean | null>(null)
  const unfollowFoldRef = useRef(false)
  const [unfollowedSessions, setUnfollowedSessions] = useState<BilibiliSession[]>([])
  const unfollowedSessionsRef = useRef<BilibiliSession[]>([])
  const [unfollowedUnread, setUnfollowedUnread] = useState(0)
  const [hasMoreUnfollowed, setHasMoreUnfollowed] = useState(false)
  const [loadingMoreUnfollowed, setLoadingMoreUnfollowed] = useState(false)
  const [unfollowedOpen, setUnfollowedOpen] = useState(false)
  // Where 未关注人消息's next page starts, null at its end, and whether one is loading. Refs, as a second call can
  // come before a render does and would load the same page again.
  const unfollowedNextEndTsRef = useRef<number | null>(null)
  const loadingMoreUnfollowedRef = useRef(false)
  // Bumped by every full load of the session lists and by the account changing, so a page or a quiet refresh
  // that a newer load, another account or another fold setting overtook doesn't land
  const listsLoadRef = useRef(0)
  // Bumped only by the account changing, for work that a reload of the same account must not cancel
  const listsAccountRef = useRef(0)
  // Bumped by every load of 未关注人消息's first page and by the account changing, so only the latest of them
  // lands. Its next pages go by where the list ends instead (see loadMoreUnfollowed).
  const unfollowedLoadRef = useRef(0)
  // The mid of the account currently connected in the renderer, so background login checks can detect failovers
  const connectedMidRef = useRef<number | null>(null)
  // Bumped whenever checkLogin or an explicit account action starts or commits, so stale checkLogin calls discard their results
  const authCheckSeqRef = useRef(0)
  // Ownership token for the current account transition, preventing the auto-connect effect from starting an
  // overlapping WebSocket connection while sessions are loading and ensuring older operations cannot clear a newer guard
  const accountTransitionIdRef = useRef(0)
  const activeTransitionIdRef = useRef<number | null>(null)
  // Tracks active explicit account actions (switchAccount, logout, removeAccount) so background checkLogin calls do not start mid-transition
  const explicitAccountActionsRef = useRef(0)
  // Tracks whether the initial session load failed (e.g. offline startup), so reconnects can retry it automatically
  const initialLoadFailedRef = useRef(false)

  const beginAccountTransition = useCallback((): number => {
    const id = ++accountTransitionIdRef.current
    activeTransitionIdRef.current = id
    return id
  }, [])

  const endAccountTransition = useCallback((id: number): boolean => {
    if (activeTransitionIdRef.current === id) {
      activeTransitionIdRef.current = null
      return true
    }
    return false
  }, [])
  const unfollowed = useMemo<UnfollowedFold | null>(
    () =>
      unfollowFold
        ? {
            sessions: unfollowedSessions,
            unread: unfollowedUnread,
            hasMore: hasMoreUnfollowed,
            loadingMore: loadingMoreUnfollowed,
            open: unfollowedOpen,
          }
        : null,
    [unfollowFold, unfollowedSessions, unfollowedUnread, hasMoreUnfollowed, loadingMoreUnfollowed, unfollowedOpen]
  )

  // Kept in step with the ref, which lookups and unread sums read without waiting for a render
  const setUnfollowed = useCallback((list: BilibiliSession[]) => {
    unfollowedSessionsRef.current = list
    setUnfollowedSessions(list)
  }, [])

  // Also set synchronously, as it decides the requests that follow. Off, 未关注人消息 can't stay open.
  const applyUnfollowFold = useCallback((folded: boolean | null) => {
    unfollowFoldRef.current = folded === true
    setUnfollowFold(folded)
    if (!folded) setUnfollowedOpen(false)
  }, [])

  // Helper to merge emoji infos into the map
  const mergeEmojiInfos = useCallback((emojiInfos: BilibiliEmojiInfo[] | undefined) => {
    if (!emojiInfos || emojiInfos.length === 0) return

    setEmojiInfoMap(prev => {
      const newMap = { ...prev }
      for (const emoji of emojiInfos) {
        // Use the emoji text as the key (e.g., "[tv_doge]")
        if (emoji.text) {
          newMap[emoji.text] = emoji
        }
      }
      return newMap
    })
  }, [])

  // Refs to access latest state in callbacks
  const sessionsRef = useRef<BilibiliSession[]>([])
  const userCacheRef = useRef<UserCache>({})
  const messagesRef = useRef<BilibiliMessage[]>([])
  const selectedSessionRef = useRef<BilibiliSession | null>(null)

  // Track window focus state to decide when to mark messages as read vs show notifications
  const windowFocusedRef = useRef(document.hasFocus())

  // Keep refs in sync with state
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    userCacheRef.current = userCache
  }, [userCache])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    selectedSessionRef.current = selectedSession
  }, [selectedSession])

  useEffect(() => {
    accountsRef.current = accounts
  }, [accounts])

  // The rest of what an account's snapshot holds, for taking one from callbacks
  const listStateRef = useRef({
    hasMoreSessions,
    nextEndTs,
    unfollowFold,
    unfollowedUnread,
    hasMoreUnfollowed,
  })
  useEffect(() => {
    listStateRef.current = { hasMoreSessions, nextEndTs, unfollowFold, unfollowedUnread, hasMoreUnfollowed }
  }, [hasMoreSessions, nextEndTs, unfollowFold, unfollowedUnread, hasMoreUnfollowed])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /** Save an account's lists on disk, unless 在本机保留聊天记录 is off */
  const saveLists = useCallback((mid: number, snapshot: AccountSnapshot) => {
    if (!useSettings.getState().keepChatsOnDevice) return
    void quietly('save the lists', () =>
      window.electronAPI.bilibili.cache.saveLists({ mid, lists: listsToSave(snapshot) })
    )
  }, [])

  /** Note this version of a chat as the one on disk */
  const markSaved = useCallback((mid: number, key: string, chat: CachedChat) => {
    savedChatsRef.current.set(chat.messages, {
      id: `${mid}/${key}`,
      emojiInfoMap: chat.emojiInfoMap,
      syncedSeqno: chat.syncedSeqno,
    })
  }, [])

  /** Whether this version of a chat is the one on disk already */
  const isSaved = useCallback((mid: number, key: string, chat: CachedChat) => {
    const saved = savedChatsRef.current.get(chat.messages)
    return (
      saved?.id === `${mid}/${key}` &&
      saved.emojiInfoMap === chat.emojiInfoMap &&
      saved.syncedSeqno === chat.syncedSeqno
    )
  }, [])

  /** Save a chat on disk, unless 在本机保留聊天记录 is off */
  const saveChat = useCallback(
    (mid: number, key: string, chat: SavedChat) => {
      if (!useSettings.getState().keepChatsOnDevice) return
      markSaved(mid, key, chat)
      void quietly('save a chat', () => window.electronAPI.bilibili.cache.saveChat({ mid, key, chat }))
    },
    [markSaved]
  )

  // Saves waiting out SAVE_DELAY go now
  const flushListsSave = useCallback(() => {
    const pending = listsSaveRef.current
    if (!pending) return
    clearTimeout(pending.timer)
    listsSaveRef.current = null
    saveLists(pending.mid, pending.snapshot)
  }, [saveLists])
  const flushChatSave = useCallback(() => {
    const pending = chatSaveRef.current
    if (!pending) return
    clearTimeout(pending.timer)
    chatSaveRef.current = null
    saveChat(pending.mid, pending.key, pending.chat)
  }, [saveChat])

  /** Drop the saves waiting out SAVE_DELAY, an account's or everyone's */
  const dropPendingSaves = useCallback((mid?: number) => {
    const lists = listsSaveRef.current
    if (lists && (mid === undefined || lists.mid === mid)) {
      clearTimeout(lists.timer)
      listsSaveRef.current = null
    }
    const chat = chatSaveRef.current
    if (chat && (mid === undefined || chat.mid === mid)) {
      clearTimeout(chat.timer)
      chatSaveRef.current = null
    }
  }, [])

  /**
   * Save the open chat on disk once it's stayed unchanged for SAVE_DELAY, unless that version is there already.
   * Another chat's save, waiting still, goes at once.
   */
  const scheduleChatSave = useCallback(
    (mid: number, key: string, chat: CachedChat) => {
      if (isSaved(mid, key, chat)) return
      const pending = chatSaveRef.current
      if (pending && (pending.mid !== mid || pending.key !== key)) flushChatSave()
      else if (pending) clearTimeout(pending.timer)
      chatSaveRef.current = {
        mid,
        key,
        // The names its senders have now, which this account's lists may not hold after a relaunch
        chat: chatToSave(chat, userCacheRef.current),
        timer: setTimeout(flushChatSave, SAVE_DELAY),
      }
    },
    [isSaved, flushChatSave]
  )

  // Save the shown lists on disk once they've stayed unchanged for SAVE_DELAY
  useEffect(() => {
    const mid = shownMidRef.current
    if (!keepOnDevice || mid === null || !listsShownRef.current) return
    const snapshot: AccountSnapshot = {
      sessions,
      hasMoreSessions,
      nextEndTs,
      unfollowFold,
      unfollowed: unfollowedSessions,
      unfollowedUnread,
      hasMoreUnfollowed,
      unfollowedNextEndTs: unfollowedNextEndTsRef.current,
      userCache,
    }
    if (listsSaveRef.current) clearTimeout(listsSaveRef.current.timer)
    listsSaveRef.current = { mid, snapshot, timer: setTimeout(flushListsSave, SAVE_DELAY) }
  }, [
    keepOnDevice,
    sessions,
    hasMoreSessions,
    nextEndTs,
    unfollowFold,
    unfollowedSessions,
    unfollowedUnread,
    hasMoreUnfollowed,
    userCache,
    flushListsSave,
  ])

  // Turned off, or off since before launch: what waits isn't saved, and what's saved is deleted
  useEffect(() => {
    if (keepOnDevice) return
    dropPendingSaves()
    savedChatsRef.current = new WeakMap()
    void quietly('delete the saved chats', () => window.electronAPI.bilibili.cache.clear())
  }, [keepOnDevice, dropPendingSaves])

  // What waits to be saved goes as the page does (the window closing, a reload) or this unmounts
  useEffect(() => {
    const flush = () => {
      flushListsSave()
      flushChatSave()
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flushListsSave, flushChatSave])

  /** An account's lists as saved on disk, null when none are or 在本机保留聊天记录 is off */
  const loadSavedLists = useCallback(async (mid: number): Promise<AccountSnapshot | null> => {
    if (!useSettings.getState().keepChatsOnDevice) return null
    return quietly('load the saved lists', () => window.electronAPI.bilibili.cache.loadLists({ mid }))
  }, [])

  /**
   * The shown account's chats with a message holding `query`, by chat key, each with the newest that does: those
   * held here, and those saved on disk unless 在本机保留聊天记录 is off. Bilibili has no search to ask, so a search
   * finds a chat by an earlier message than its last only once it's been opened, here or before a relaunch.
   */
  const searchHeldChats = useCallback(
    async (query: string): Promise<Map<string, MessageMatch>> => {
      const found = new Map<string, MessageMatch>()
      const mid = shownMidRef.current
      const needle = query.trim().toLowerCase()
      if (mid === null || !needle) return found
      if (useSettings.getState().keepChatsOnDevice) {
        const saved = await quietly('search the saved chats', () =>
          window.electronAPI.bilibili.cache.searchChats({ mid, query: needle })
        )
        for (const { key, ...match } of saved ?? []) found.set(key, match)
        // Another account showed meanwhile
        if (mid !== shownMidRef.current) return new Map()
      }
      // A chat held here is as new as its copy on disk, or newer (a message recalled since, say), so it decides
      for (const [key, chat] of chatCache.chatsOf(mid)) {
        const match = findMessage(chat.messages, needle)
        if (match === null) found.delete(key)
        else found.set(key, match)
      }
      return found
    },
    [chatCache]
  )

  // A session as listed now, in the main list or in 未关注人消息
  const findListedSession = useCallback(
    (match: (s: BilibiliSession) => boolean) =>
      sessionsRef.current.find(match) ?? unfollowedSessionsRef.current.find(match),
    []
  )

  // Change a session wherever it's listed: in the main list, or in 未关注人消息, whose unread moves with its chats'
  const updateSession = useCallback(
    (match: (s: BilibiliSession) => boolean, change: (s: BilibiliSession) => BilibiliSession) => {
      setSessions(prev => prev.map(s => (match(s) ? change(s) : s)))

      let listed = false
      let unread = 0
      const list = unfollowedSessionsRef.current.map(s => {
        if (!match(s)) return s
        listed = true
        const changed = change(s)
        unread += (changed.unread_count || 0) - (s.unread_count || 0)
        return changed
      })
      if (!listed) return
      setUnfollowed(list)
      if (unread !== 0) setUnfollowedUnread(total => Math.max(0, total + unread))
    },
    [setUnfollowed]
  )

  // Whether 收起未关注人消息 keeps this chat in 未关注人消息 rather than the main list
  const isFolded = useCallback((session: BilibiliSession) => unfollowFoldRef.current && isUnfollowedChat(session), [])

  const customerServiceSessionsRef = useRef<CustomerServiceSession[]>([])
  const activeCustomerServiceShopRef = useRef<CustomerServiceShop | null>(null)
  // Bumped when another account signs in. Its chats can share shop ids with this one's
  // (Bilibili's own is 0/0 for everyone), so replies still out for the last account check it
  const customerServiceAccountRef = useRef(0)
  // Bumped by every load of a conversation or customer service chat (and by the account changing), so only
  // the latest load lands: the next account can have the same contact, or the same chat
  const messagesLoadRef = useRef(0)

  // Kept in step with the ref, which unread sums read without waiting for a render
  const setChats = useCallback((list: CustomerServiceSession[]) => {
    customerServiceSessionsRef.current = list
    setCustomerServiceSessions(list)
  }, [])

  // Also set synchronously, so a reply for a chat the user just left can tell
  const setActiveShop = useCallback((shop: CustomerServiceShop | null) => {
    activeCustomerServiceShopRef.current = shop
    setActiveCustomerServiceShop(shop)
  }, [])

  // Customer service chats belong to an account: forget them when another one signs in
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the account changes
  useEffect(() => {
    customerServiceAccountRef.current++
    messagesLoadRef.current++
    setChats([])
    setActiveShop(null)
  }, [userInfo?.mid, setChats, setActiveShop])

  // Whether a reply for this customer service chat is still wanted
  const isCustomerServiceOpen = useCallback((shop: CustomerServiceShop) => {
    const session = selectedSessionRef.current
    return !!session && isCustomerServiceSession(session) && isSameShop(activeCustomerServiceShopRef.current, shop)
  }, [])

  // Mark a customer service chat as read, and take it off 客服消息's unread, which counts every chat's
  const ackCustomerService = useCallback(
    (shop: CustomerServiceShop) => {
      window.electronAPI.bilibili.customerService
        .updateAck(shop)
        .then(result => {
          if (isErrorResponse(result)) console.error('Failed to mark customer service chat as read:', result.error)
        })
        .catch(err => console.error('Failed to mark customer service chat as read:', err))

      const chats = customerServiceSessionsRef.current.map(s =>
        isSameShop(getCustomerServiceShop(s), shop) ? { ...s, unread_info: { ...s.unread_info, unread_count: 0 } } : s
      )
      const othersUnread = chats.reduce((sum, s) => sum + (s.unread_info?.unread_count || 0), 0)
      setChats(chats)
      setSessions(prev => prev.map(s => (isCustomerServiceSession(s) ? { ...s, unread_count: othersUnread } : s)))
    },
    [setChats]
  )

  // Track window focus state and mark current session as read when regaining focus
  useEffect(() => {
    const handleFocus = () => {
      windowFocusedRef.current = true

      // When window regains focus, mark the current session as read
      const session = selectedSessionRef.current
      // 客服消息 is read one customer service chat at a time, once it shows (not while it loads, or if it failed to)
      if (session && isCustomerServiceSession(session)) {
        const shop = activeCustomerServiceShopRef.current
        if (shop && messagesRef.current.length > 0) ackCustomerService(shop)
      } else if (session) {
        // Derive the latest seqno from current messages to avoid using stale session data.
        // selectedSession.max_seqno may not reflect messages that arrived while unfocused.
        const currentMessages = messagesRef.current
        const latestSeqno = currentMessages.reduce((max, m) => Math.max(max, m.msg_seqno), session.max_seqno || 0)

        window.electronAPI.bilibili
          .updateAck({
            talkerId: String(session.talker_id),
            sessionType: String(session.session_type),
            ackSeqno: String(latestSeqno),
          })
          .catch(err => console.error('Failed to mark as read on focus:', err))

        // Reset unread count for the selected session
        updateSession(
          s => s.talker_id === session.talker_id && s.session_type === session.session_type,
          s => ({ ...s, unread_count: 0 })
        )
      }
    }

    const handleBlur = () => {
      windowFocusedRef.current = false
    }

    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
    }
  }, [ackCustomerService, updateSession])

  /**
   * Fetch names and faces in batches, as the signed-in account unless `mid` names another, handing each batch to
   * `onBatch` as it lands. A batch that fails is skipped, and none starts once `stop` says so.
   */
  const fetchUserCards = useCallback(
    async (uids: number[], onBatch: (cards: UserCache) => void, mid?: number, stop?: () => boolean) => {
      // Batch up to 50 users per request (API limit)
      const batchSize = 50
      for (let i = 0; i < uids.length; i += batchSize) {
        if (stop?.()) return
        const batch = uids.slice(i, i + batchSize)
        try {
          const data = await window.electronAPI.bilibili.fetchUsers({ uids: batch.join(','), mid })
          if (isErrorResponse(data) || data.code !== 0 || !data.data) continue

          const cards: UserCache = {}
          for (const user of data.data) {
            cards[user.mid] = {
              name: user.name,
              face: user.face,
              official: user.official,
              vip: user.vip,
            }
          }
          onBatch(cards)
        } catch (err) {
          console.error('Failed to fetch user info batch:', err)
        }
      }
    },
    []
  )

  // Fetch user info for multiple users in batch
  const fetchUserInfoBatch = useCallback(
    async (uids: number[]) => {
      if (uids.length === 0) return
      // The account may change while the batches load, and these are the names of this one's contacts
      const account = listsAccountRef.current
      await fetchUserCards(uids, cards => {
        if (account === listsAccountRef.current) setUserCache(prev => ({ ...prev, ...cards }))
      })
    },
    [fetchUserCards]
  )

  // Read 收起未关注人消息 for the signed-in account, or for another stored account by mid; null when it can't be read
  const readUnfollowFold = useCallback(async (mid?: number): Promise<boolean | null> => {
    try {
      const data = await window.electronAPI.bilibili.fetchLinkSetting({ mid })
      if (!isErrorResponse(data) && data.code === 0) return data.data?.show_unfollowed_msg === 1
      console.error('[usePrivateMessages] Failed to read 收起未关注人消息:', isErrorResponse(data) ? data.error : data)
    } catch (err) {
      console.error('[usePrivateMessages] Failed to read 收起未关注人消息:', err)
    }
    return null
  }, [])

  // Fetch 未关注人消息's first page and its unread, null when the page fails; its unread is null when only that fails.
  // The signed-in account's, or another stored account's by mid.
  const fetchUnfollowed = useCallback(async (mid?: number): Promise<UnfollowedPage | null> => {
    try {
      const [page, unread] = await Promise.all([
        window.electronAPI.bilibili.fetchSessions({
          sessionType: String(SESSION_LIST_TYPE.UNFOLLOWED),
          unfollowFold: true,
          mid,
        }),
        window.electronAPI.bilibili.fetchSingleUnread({ mid }),
      ])
      if (isErrorResponse(page) || page.code !== 0) {
        console.error('[usePrivateMessages] Failed to fetch 未关注人消息:', page)
        return null
      }
      const unreadCounted = !isErrorResponse(unread) && unread.code === 0
      if (!unreadCounted) console.error('[usePrivateMessages] Failed to fetch 未关注人消息 unread:', unread)

      return {
        sessions: page.data?.session_list || [],
        hasMore: firstPageGoesOn(page, true),
        unread: unreadCounted ? (unread.data?.unfollow_unread ?? 0) : null,
      }
    } catch (err) {
      console.error('[usePrivateMessages] Failed to fetch 未关注人消息:', err)
      return null
    }
  }, [])

  // Show 未关注人消息 from a first page, or empty it (with the fold off, say)
  // With `keepPages`, the pages loaded past the first stay when they still follow on from it (see keepLoadedPages)
  const showUnfollowed = useCallback(
    (page: UnfollowedPage | null, keepPages = false) => {
      const fresh = page?.sessions ?? []
      const kept = keepPages && page ? keepLoadedPages(unfollowedSessionsRef.current, fresh, page.hasMore) : null
      const list = kept ?? fresh
      setUnfollowed(list)
      // Kept pages end where they did, and so does what loads next
      if (!kept) {
        setHasMoreUnfollowed(!!page?.hasMore)
        unfollowedNextEndTsRef.current = page?.hasMore ? lastSessionTs(list) : null
      }
      if (page?.unread !== null) setUnfollowedUnread(page?.unread ?? 0)

      // Its chats are all with users, who come without account_info; a refresh only asks after new ones
      const uidsToFetch = list
        .filter(session => !session.account_info?.name && !userCacheRef.current[session.talker_id])
        .map(session => session.talker_id)
      if (uidsToFetch.length > 0) fetchUserInfoBatch(uidsToFetch)
    },
    [setUnfollowed, fetchUserInfoBatch]
  )

  // Forget 未关注人消息 and the setting that folds it, and drop the list loads still out, as the account they
  // belong to signs out or another signs in
  const forgetAccountLists = useCallback(() => {
    listsLoadRef.current++
    listsAccountRef.current++
    unfollowedLoadRef.current++
    applyUnfollowFold(null)
    showUnfollowed(null)
  }, [applyUnfollowFold, showUnfollowed])

  // Refresh 未关注人消息 from its first page. Resolves to the chats it lists, which stay as they were when the
  // page fails, or when a newer load or the fold turning off overtakes it.
  const loadUnfollowed = useCallback(async (): Promise<BilibiliSession[]> => {
    const load = ++unfollowedLoadRef.current
    const page = await fetchUnfollowed()
    if (page && load === unfollowedLoadRef.current && unfollowFoldRef.current) showUnfollowed(page, true)
    return unfollowedSessionsRef.current
  }, [fetchUnfollowed, showUnfollowed])

  const unfollowedRefreshRef = useRef<Promise<BilibiliSession[]> | null>(null)
  const unfollowedNextRefreshRef = useRef<Promise<BilibiliSession[]> | null>(null)

  // Refresh 未关注人消息 without a spinner. A message brings several notifications, so those that ask while a
  // refresh runs share one more after it, which can't have been sent before what they ask about.
  const refreshUnfollowedQuietly = useCallback((): Promise<BilibiliSession[]> => {
    const start = (): Promise<BilibiliSession[]> => {
      const refresh: Promise<BilibiliSession[]> = loadUnfollowed().finally(() => {
        if (unfollowedRefreshRef.current === refresh) unfollowedRefreshRef.current = null
      })
      unfollowedRefreshRef.current = refresh
      return refresh
    }

    const running = unfollowedRefreshRef.current
    if (!running) return start()
    unfollowedNextRefreshRef.current ??= running.then(() => {
      unfollowedNextRefreshRef.current = null
      return start()
    })
    return unfollowedNextRefreshRef.current
  }, [loadUnfollowed])

  // Load the next page of 未关注人消息
  const loadMoreUnfollowed = useCallback(async () => {
    const endTs = unfollowedNextEndTsRef.current
    if (endTs === null || loadingMoreUnfollowedRef.current) return

    loadingMoreUnfollowedRef.current = true
    setLoadingMoreUnfollowed(true)
    const account = listsAccountRef.current
    try {
      const data = await window.electronAPI.bilibili.fetchSessions({
        sessionType: String(SESSION_LIST_TYPE.UNFOLLOWED),
        unfollowFold: true,
        endTs: String(endTs),
      })
      // It lands while the list still ends where it was asked from. Refreshes of the first page, which come with
      // messages and unread changes, keep the pages loaded past it, so one landing meanwhile doesn't drop it;
      // another account, the fold turning off, or a load that starts the list over does.
      if (account !== listsAccountRef.current || !unfollowFoldRef.current || unfollowedNextEndTsRef.current !== endTs) {
        return
      }

      if (isErrorResponse(data)) {
        throw new Error(data.error || 'Failed to fetch more sessions')
      }
      if (data.code !== 0) {
        throw new Error(data.message || 'Failed to fetch more sessions')
      }

      const sessionList = data.data?.session_list || []
      const hasMore = data.data?.has_more === 1 && sessionList.length > 0
      // A chat that moved to the top meanwhile, with a message, is listed there already
      const listed = new Set(unfollowedSessionsRef.current.map(chatKey))
      const added = sessionList.filter(session => !listed.has(chatKey(session)))
      setUnfollowed([...unfollowedSessionsRef.current, ...added])
      setHasMoreUnfollowed(hasMore)
      unfollowedNextEndTsRef.current = hasMore ? lastSessionTs(sessionList) : null

      const uidsToFetch = added
        .filter(session => !session.account_info?.name && !userCacheRef.current[session.talker_id])
        .map(session => session.talker_id)
      if (uidsToFetch.length > 0) fetchUserInfoBatch(uidsToFetch)
    } catch (err) {
      console.error('[usePrivateMessages] Failed to load more of 未关注人消息:', err)
    } finally {
      loadingMoreUnfollowedRef.current = false
      setLoadingMoreUnfollowed(false)
    }
  }, [setUnfollowed, fetchUserInfoBatch])

  // List 未关注人消息's chats in place of the main list, refreshed as Bilibili's web client does on opening them
  const openUnfollowed = useCallback(() => {
    setUnfollowedOpen(true)
    refreshUnfollowedQuietly()
  }, [refreshUnfollowedQuietly])

  const closeUnfollowed = useCallback(() => {
    setUnfollowedOpen(false)
  }, [])

  // Show system notification for a new message
  const showNotificationForMessage = useCallback(
    async (
      message: BilibiliMessage,
      senderUid: number,
      talkerId: number,
      sessionType: number,
      refreshedSessions: Promise<BilibiliSession[]>
    ) => {
      // Don't notify for our own messages
      if (userInfo?.mid && senderUid === userInfo.mid) return

      // Check if session is in DND mode - suppress notifications
      // The WS payload has no DND flag and only loaded pages are in state. A session that just
      // received a message sorts to the top of the first page, so use this message's refresh when it's missing.
      const isTargetSession = (s: BilibiliSession) => s.talker_id === talkerId && s.session_type === sessionType
      const session = findListedSession(isTargetSession) ?? (await refreshedSessions).find(isTargetSession)
      if (session?.is_dnd === 1) {
        console.log('[usePrivateMessages] Notification suppressed for DND session:', talkerId)
        return
      }
      // Nor for chats folded into 未关注人消息, whose unread Bilibili leaves out of the count it shows, but for
      // the one open now, which the user is in the middle of
      const open = selectedSessionRef.current
      if (session && isFolded(session) && !(open && isTargetSession(open))) {
        console.log('[usePrivateMessages] Notification suppressed for chat in 未关注人消息:', talkerId)
        return
      }

      // Get sender info from cache or sessions
      let senderName = `用户 ${senderUid}`
      let senderAvatar: string | undefined

      // Try to get from user cache
      const cachedUser = userCacheRef.current[senderUid]
      if (cachedUser) {
        senderName = cachedUser.name
        senderAvatar = cachedUser.face
      } else {
        // Try to get from sessions
        const session = sessionsRef.current.find(s => s.talker_id === senderUid)
        if (session?.account_info) {
          senderName = session.account_info.name
          senderAvatar = session.account_info.pic_url
        } else {
          // User not in cache or sessions (first-ever message from this user)
          // Fetch user info before showing notification
          try {
            const data = await window.electronAPI.bilibili.fetchUsers({
              uids: String(senderUid),
            })

            if (!isErrorResponse(data) && data.code === 0 && data.data?.[0]) {
              const user = data.data[0]
              senderName = user.name
              senderAvatar = user.face

              // Also update cache for future use
              setUserCache(prev => ({
                ...prev,
                [user.mid]: {
                  name: user.name,
                  face: user.face,
                  official: user.official,
                  vip: user.vip,
                },
              }))
            }
          } catch (err) {
            console.error('[usePrivateMessages] Failed to fetch user info for notification:', err)
            // Continue with fallback name
          }
        }
      }

      // Parse message content
      const messageText = parseMessageContent(message)

      try {
        const result = await window.electronAPI.bilibili.showNotification({
          title: senderName,
          body: messageText || '[新消息]',
          icon: senderAvatar,
          talkerId,
          sessionType,
        })
        console.log('[usePrivateMessages] Notification result:', result)
      } catch (err) {
        console.error('[usePrivateMessages] Failed to show notification:', err)
      }
    },
    [userInfo, findListedSession, isFolded]
  )

  /** Clear all per-account session, message, and fold state in the renderer */
  const resetAccountState = useCallback(() => {
    initialLoadFailedRef.current = false
    shownMidRef.current = null
    listsShownRef.current = false
    syncedSeqnoRef.current = 0
    // Ahead of the render, so loads for the account left behind can tell they're stale
    selectedSessionRef.current = null
    sessionsRef.current = []
    userCacheRef.current = {}
    setSessions([])
    setSelectedSession(null)
    setMessages([])
    setUserCache({})
    setHasMoreSessions(false)
    setNextEndTs(null)
    forgetAccountLists()
  }, [forgetAccountLists])

  /** Keep the lists shown now as their account's snapshot, to show again when it comes back */
  const rememberShownAccount = useCallback(() => {
    const mid = shownMidRef.current
    if (mid === null || !listsShownRef.current) return
    const state = listStateRef.current
    snapshots.set(mid, {
      sessions: sessionsRef.current,
      hasMoreSessions: state.hasMoreSessions,
      nextEndTs: state.nextEndTs,
      unfollowFold: state.unfollowFold,
      unfollowed: unfollowedSessionsRef.current,
      unfollowedUnread: state.unfollowedUnread,
      hasMoreUnfollowed: state.hasMoreUnfollowed,
      unfollowedNextEndTs: unfollowedNextEndTsRef.current,
      userCache: userCacheRef.current,
    })
    // On disk too, now rather than once the next account shows
    flushListsSave()
    flushChatSave()
  }, [snapshots, flushListsSave, flushChatSave])

  /**
   * Make `mid` the account the state holds, showing its lists from its snapshot if it has one while they load,
   * rather than a blank list
   */
  const showAccount = useCallback(
    (mid: number) => {
      shownMidRef.current = mid
      const snapshot = snapshots.get(mid)
      if (!snapshot) return

      listsShownRef.current = true
      applyUnfollowFold(snapshot.unfollowFold)
      setUnfollowed(snapshot.unfollowed)
      setUnfollowedUnread(snapshot.unfollowedUnread)
      setHasMoreUnfollowed(snapshot.hasMoreUnfollowed)
      unfollowedNextEndTsRef.current = snapshot.unfollowedNextEndTs
      sessionsRef.current = snapshot.sessions
      setSessions(snapshot.sessions)
      setHasMoreSessions(snapshot.hasMoreSessions)
      setNextEndTs(snapshot.nextEndTs)
      userCacheRef.current = snapshot.userCache
      setUserCache(snapshot.userCache)
    },
    [snapshots, applyUnfollowFold, setUnfollowed]
  )

  /**
   * Forget everything kept of an account, as it signs out or is removed. The main process deletes what's on disk
   * of it, and refuses saves for it from then on.
   */
  const forgetAccount = useCallback(
    (mid: number) => {
      snapshots.delete(mid)
      chatCache.forgetAccount(mid)
      dropPendingSaves(mid)
      // Signed in again, it loads in the background again
      warmedUp.delete(mid)
    },
    [snapshots, chatCache, dropPendingSaves, warmedUp]
  )

  /**
   * Another stored account's lists from their first pages, as a snapshot to show when the user switches to it;
   * null when either list fails, or when Comet unmounts on the way
   */
  const fetchAccountSnapshot = useCallback(
    async (mid: number): Promise<AccountSnapshot | null> => {
      const gone = () => !mountedRef.current
      try {
        const setting = await readUnfollowFold(mid)
        if (gone()) return null
        const fold = setting === true
        const [data, unfollowedPage] = await Promise.all([
          window.electronAPI.bilibili.fetchSessions({ unfollowFold: fold, mid }),
          fold ? fetchUnfollowed(mid) : null,
        ])
        if (gone() || isErrorResponse(data) || data.code !== 0 || (fold && !unfollowedPage)) return null

        const sessions = data.data?.session_list || []
        const unfollowed = unfollowedPage?.sessions ?? []
        const hasMoreUnfollowed = !!unfollowedPage?.hasMore
        // Chats with users come without names, which the session list shows
        const uids = [...sessions.filter(s => s.session_type === SESSION_TYPE.USER), ...unfollowed]
          .filter(s => !s.account_info?.name)
          .map(s => s.talker_id)
        const userCache: UserCache = {}
        await fetchUserCards([...new Set(uids)], cards => Object.assign(userCache, cards), mid, gone)
        if (gone()) return null

        return {
          sessions,
          hasMoreSessions: firstPageGoesOn(data, fold),
          nextEndTs: lastSessionTs(sessions),
          unfollowFold: setting,
          unfollowed,
          unfollowedUnread: unfollowedPage?.unread ?? 0,
          hasMoreUnfollowed,
          unfollowedNextEndTs: hasMoreUnfollowed ? lastSessionTs(unfollowed) : null,
          userCache,
        }
      } catch (err) {
        console.warn('[usePrivateMessages] Failed to load lists in the background for account', mid, err)
        return null
      }
    },
    [readUnfollowFold, fetchUnfollowed, fetchUserCards]
  )

  // Whether other accounts' lists are loading in the background
  const warmingUpRef = useRef(false)

  /**
   * Have every other stored account's lists ready in the background, one account at a time, so switching to one
   * shows them at once instead of a blank list while they load: as saved on disk if they are, else their first
   * pages from Bilibili. Skips expired accounts, whose cookies would fail, and accounts with a snapshot already,
   * which a switch refreshes anyway.
   */
  const warmUpAccounts = useCallback(async () => {
    if (warmingUpRef.current) return
    warmingUpRef.current = true
    try {
      for (const { mid, isExpired } of accountsRef.current) {
        if (!mountedRef.current) return
        if (isExpired || mid === shownMidRef.current || snapshots.has(mid) || warmedUp.has(mid)) continue

        warmedUp.add(mid)
        const saved = await loadSavedLists(mid)
        const snapshot = saved ?? (await fetchAccountSnapshot(mid))
        // Switched to, signed out or removed meanwhile: the lists shown, or nothing, win over these
        const stored = accountsRef.current.some(a => a.mid === mid)
        if (snapshot && stored && mid !== shownMidRef.current && !snapshots.has(mid)) {
          snapshots.set(mid, snapshot)
          if (!saved) saveLists(mid, snapshot)
        }
      }
    } finally {
      warmingUpRef.current = false
    }
  }, [snapshots, warmedUp, loadSavedLists, fetchAccountSnapshot, saveLists])

  // Where the main list ends since it last started over from a first page, a new object each time, so a next page
  // asked from further down before that doesn't land on it (see loadMoreSessions)
  const sessionsStartRef = useRef({ end: Number.POSITIVE_INFINITY })

  /**
   * Show the main list from its first page, fetched again. With `keepPages`, the pages loaded past it stay where they
   * still follow on from it (see keepLoadedPages), ending where they did, and so does what loads next. A page with
   * no sessions leaves where the next page starts as it was.
   */
  const showSessionsPage = useCallback((page: BilibiliSession[], hasMore: boolean, keepPages: boolean) => {
    const kept = keepPages ? keepLoadedPages(sessionsRef.current, page, hasMore) : null
    if (kept) {
      sessionsRef.current = kept
      setSessions(kept)
      return
    }
    // Ahead of the render, so a refresh landing right after compares against this list, not the one it replaced
    sessionsRef.current = page
    // The list starts over, ending here: a next page asked from further down than this doesn't follow on from it
    sessionsStartRef.current = { end: lastSessionTs(page) ?? Number.POSITIVE_INFINITY }
    setSessions(page)
    setHasMoreSessions(hasMore)
    if (page.length > 0) setNextEndTs(lastSessionTs(page))
  }, [])

  // Load the signed-in account's sessions from the first page. Its 收起未关注人消息 setting, read first unless
  // given (unreadable, nothing folds), decides whether chats with people it doesn't follow list here or in
  // 未关注人消息. Both lists show together once both have loaded, so no chat goes missing between them or shows
  // in both; when either fails, what's shown stays and this throws. Resolves to false when a newer load or
  // another account overtook it, which leaves everything to that one.
  const loadSessions = useCallback(
    async (folded?: boolean, keepPages = false): Promise<boolean> => {
      const load = ++listsLoadRef.current
      const setting = folded ?? (await readUnfollowFold())
      if (load !== listsLoadRef.current) return false

      const fold = setting === true
      const [data, unfollowedPage] = await Promise.all([
        window.electronAPI.bilibili.fetchSessions({ unfollowFold: fold }),
        fold ? fetchUnfollowed() : null,
      ])
      if (load !== listsLoadRef.current) return false

      if (isErrorResponse(data)) {
        throw new Error(data.error || 'Failed to fetch sessions')
      }

      if (data.code !== 0) {
        throw new Error(data.message || 'Failed to fetch sessions')
      }

      if (fold && !unfollowedPage) {
        throw new Error('Failed to fetch 未关注人消息')
      }

      // With `keepPages`, the pages loaded past the first stay where they still follow on from it, as a refresh
      // keeps them, unless the lists fold another way now
      const keep = keepPages && listsShownRef.current && unfollowFoldRef.current === fold
      applyUnfollowFold(setting)
      // Refreshes of 未关注人消息 sent before this would land over it
      unfollowedLoadRef.current++
      showUnfollowed(unfollowedPage, keep)

      const sessionList = data.data?.session_list || []
      showSessionsPage(sessionList, firstPageGoesOn(data, fold), keep)
      // Loading the list over, an empty first page leaves no next page to load
      if (sessionList.length === 0) setNextEndTs(null)

      // Find user sessions that don't have account_info and need fetching
      const uidsToFetch = sessionList
        .filter(session => session.session_type === SESSION_TYPE.USER && !session.account_info?.name)
        .map(session => session.talker_id)

      // Fetch user info for those sessions
      if (uidsToFetch.length > 0) {
        fetchUserInfoBatch(uidsToFetch)
      }
      initialLoadFailedRef.current = false
      // The state holds the signed-in account's lists now. With them in, get the other accounts' ready for a switch.
      if (connectedMidRef.current !== null) shownMidRef.current = connectedMidRef.current
      listsShownRef.current = true
      void warmUpAccounts()
      return true
    },
    [
      readUnfollowFold,
      fetchUnfollowed,
      applyUnfollowFold,
      showUnfollowed,
      showSessionsPage,
      fetchUserInfoBatch,
      warmUpAccounts,
    ]
  )

  // Bumped by every load of an account's lists after it changed, so only the latest clears the skeleton
  const listsPendingLoadRef = useRef(0)

  /**
   * Load the signed-in account's lists after the account changed: over its snapshot if one shows, else with a
   * skeleton until they land or fail. Throws as loadSessions does.
   */
  const loadAccountLists = useCallback(async () => {
    const load = ++listsPendingLoadRef.current
    setListsPending(!listsShownRef.current)
    try {
      await loadSessions(undefined, true)
    } finally {
      if (load === listsPendingLoadRef.current) setListsPending(false)
    }
  }, [loadSessions])

  /** Validate the active account's login state and reconcile renderer state on failover or sign-out */
  const checkLogin = useCallback(async (): Promise<boolean> => {
    if (explicitAccountActionsRef.current > 0) return false
    const checkSeq = ++authCheckSeqRef.current
    const previousMid = connectedMidRef.current
    try {
      const result = await window.electronAPI.bilibili.checkLogin()
      if (checkSeq !== authCheckSeqRef.current || explicitAccountActionsRef.current > 0) return false

      // Refresh accounts after checkLogin since it may have marked expired accounts
      const accountsResult = await window.electronAPI.bilibili.getAccounts()
      if (checkSeq !== authCheckSeqRef.current || explicitAccountActionsRef.current > 0) return false

      setUserInfo(result)
      setAccounts(accountsResult.accounts)
      setActiveAccountMid(accountsResult.activeAccountMid)

      if (result.isLogin) {
        const nextMid = result.mid ?? null
        connectedMidRef.current = nextMid

        // When a background check fails over from an expired active account to another valid account,
        // clear the previous account's state, load the new account's sessions, and reconnect WebSocket
        if (previousMid !== null && nextMid !== null && nextMid !== previousMid) {
          const transitionId = beginAccountTransition()
          let shouldReconnect = false
          try {
            await window.electronAPI.bilibili.wsDisconnect()
            setWsConnected(false)
            // The account left behind can come back (when this was an account being added, say)
            rememberShownAccount()
            resetAccountState()
            showAccount(nextMid)
            setIsConnected(true)
            try {
              await loadAccountLists()
            } catch (err) {
              initialLoadFailedRef.current = true
              console.error('Failed to fetch sessions for the next account:', err)
            }
          } finally {
            shouldReconnect = endAccountTransition(transitionId)
          }
          if (shouldReconnect && explicitAccountActionsRef.current === 0 && connectedMidRef.current === nextMid) {
            await window.electronAPI.bilibili.wsConnect()
          }
          return true
        }

        setIsConnected(true)
        if (initialLoadFailedRef.current) {
          try {
            await loadSessions()
          } catch (err) {
            console.error('Failed to retry initial session load:', err)
          }
        }
        return true
      }

      if (previousMid !== null) {
        connectedMidRef.current = null
        await window.electronAPI.bilibili.wsDisconnect()
        setWsConnected(false)
        resetAccountState()
      }
      setIsConnected(false)
      return false
    } catch (err) {
      if (checkSeq !== authCheckSeqRef.current || explicitAccountActionsRef.current > 0) return false
      console.error('Failed to check login:', err)
      setIsConnected(false)
      return false
    }
  }, [
    loadSessions,
    loadAccountLists,
    resetAccountState,
    rememberShownAccount,
    showAccount,
    beginAccountTransition,
    endAccountTransition,
  ])

  /**
   * Reconcile renderer state after the backend has committed an active-account change (`setActiveAccount`,
   * `removeAccount`, or `logout`). Retries once if `checkLogin` or `getAccounts` fails, and never loads
   * sessions or connects WebSocket without a verified `userInfo` profile.
   */
  const reconcileCommittedAccount = useCallback(
    async (transitionId: number): Promise<void> => {
      let loginResult: CheckLoginResult | null = null
      let lastError: unknown = null

      for (let attempt = 0; attempt < 2; attempt++) {
        if (activeTransitionIdRef.current !== transitionId) return
        try {
          const checked = await window.electronAPI.bilibili.checkLogin()
          if (activeTransitionIdRef.current !== transitionId) return
          authCheckSeqRef.current++
          setUserInfo(checked)
          loginResult = checked

          const accountsResult = await window.electronAPI.bilibili.getAccounts()
          if (activeTransitionIdRef.current !== transitionId) return
          authCheckSeqRef.current++
          setAccounts(accountsResult.accounts)
          setActiveAccountMid(accountsResult.activeAccountMid)
          lastError = null
          break
        } catch (err) {
          if (activeTransitionIdRef.current !== transitionId) return
          lastError = err
        }
      }

      if (activeTransitionIdRef.current !== transitionId) return

      if (lastError || !loginResult) {
        connectedMidRef.current = null
        setUserInfo(null)
        resetAccountState()
        initialLoadFailedRef.current = true
        setIsConnected(false)
        throw lastError ?? new Error('Failed to reconcile active account')
      }

      if (loginResult.isLogin) {
        const mid = loginResult.mid ?? null
        connectedMidRef.current = mid
        // The account signed in can be another than the one shown: the next one, when that one had expired
        if (mid !== shownMidRef.current) {
          resetAccountState()
          if (mid !== null) showAccount(mid)
        }
        setIsConnected(true)
        try {
          await loadAccountLists()
        } catch (err) {
          // Retried on reconnecting, over whatever shows meanwhile
          if (activeTransitionIdRef.current === transitionId) initialLoadFailedRef.current = true
          console.error('[usePrivateMessages] Failed to fetch sessions for the active account:', err)
        }
        if (endAccountTransition(transitionId)) {
          await window.electronAPI.bilibili.wsConnect()
        }
      } else {
        // Nothing of the account shown stays behind the login screen
        resetAccountState()
        initialLoadFailedRef.current = false
        setIsConnected(false)
      }
    },
    [loadAccountLists, resetAccountState, showAccount, endAccountTransition]
  )

  // Logout
  const logout = useCallback(async () => {
    explicitAccountActionsRef.current++
    authCheckSeqRef.current++
    const transitionId = beginAccountTransition()
    try {
      // Disconnect WebSocket first to stop receiving notifications for this user
      await window.electronAPI.bilibili.wsDisconnect()
      if (activeTransitionIdRef.current !== transitionId) return
      setWsConnected(false)

      await window.electronAPI.bilibili.logout()
      authCheckSeqRef.current++

      // Logout removes the active account, so forget its drafts and everything kept of it too
      if (userInfo?.mid) {
        useDrafts.getState().clearAccountDrafts(userInfo.mid)
        forgetAccount(userInfo.mid)
      }
      if (activeTransitionIdRef.current !== transitionId) return

      // Clear current session state
      connectedMidRef.current = null
      setUserInfo(null)
      resetAccountState()

      await reconcileCommittedAccount(transitionId)
    } catch (err) {
      console.error('Failed to logout:', err)
    } finally {
      endAccountTransition(transitionId)
      explicitAccountActionsRef.current--
    }
  }, [
    resetAccountState,
    forgetAccount,
    userInfo?.mid,
    beginAccountTransition,
    endAccountTransition,
    reconcileCommittedAccount,
  ])

  /** Fetch the active account's initial session list without disconnecting on transient failures */
  const fetchSessions = useCallback(async () => {
    // An account changing loads the lists it changes to itself (at launch, behind those saved from last time)
    if (activeTransitionIdRef.current !== null) return
    setLoading(true)
    setError(null)

    try {
      if (await loadSessions()) setIsConnected(true)
    } catch (err) {
      if (sessionsRef.current.length === 0) {
        initialLoadFailedRef.current = true
      }
      setError(err instanceof Error ? err.message : 'Failed to fetch sessions')
    } finally {
      setLoading(false)
    }
  }, [loadSessions])

  // Turn 收起未关注人消息 on or off. It's the account's setting on Bilibili, so its other clients follow.
  const toggleUnfollowFold = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      const account = listsAccountRef.current
      try {
        const result = await window.electronAPI.bilibili.setUnfollowFold({ enabled })
        if (!result.success) {
          console.error('Failed to change 收起未关注人消息:', result.error)
          toastManager.add({
            type: 'error',
            title: '操作失败',
            description: result.error || '无法更改收起未关注人消息设置',
          })
          return false
        }
      } catch (err) {
        console.error('Failed to change 收起未关注人消息:', err)
        toastManager.add({
          type: 'error',
          title: '操作失败',
          description: '无法更改收起未关注人消息设置',
        })
        return false
      }

      // Another account signed in while it saved, and its lists follow its own setting
      if (account !== listsAccountRef.current) return true

      // The lists fold or unfold with it, as set, overtaking any reload that read it before it saved: reading it
      // back this soon could still see the old value
      try {
        await loadSessions(enabled)
      } catch (err) {
        console.error('Failed to reload sessions:', err)
        toastManager.add({
          type: 'error',
          title: '会话刷新失败',
          description: '收起未关注人消息已更改，刷新会话后生效',
        })
      }
      return true
    },
    [loadSessions]
  )

  const loadMoreSessions = useCallback(async () => {
    if (!hasMoreSessions || nextEndTs === null || loadingMore) return

    setLoadingMore(true)
    const endTs = nextEndTs
    const load = listsLoadRef.current
    const start = sessionsStartRef.current
    const fold = unfollowFoldRef.current

    try {
      const data = await window.electronAPI.bilibili.fetchSessions({
        endTs: String(endTs),
        unfollowFold: fold,
      })

      if (isErrorResponse(data)) {
        throw new Error(data.error || 'Failed to fetch more sessions')
      }

      if (data.code !== 0) {
        throw new Error(data.message || 'Failed to fetch more sessions')
      }

      // A full load, another account or the fold setting changing overtook this page, or a refresh started the list
      // over ending above where it starts, leaving a gap. One that kept the pages loaded, or listed the same chats
      // again (so the list still ends where it was asked from), leaves it following on.
      const restart = sessionsStartRef.current
      if (
        load !== listsLoadRef.current ||
        fold !== unfollowFoldRef.current ||
        (restart !== start && restart.end > endTs)
      ) {
        return
      }

      const sessionList = data.data?.session_list || []
      // A chat that moved to the top meanwhile, with a message, is listed there already
      setSessions(prev => {
        const listed = new Set(prev.map(chatKey))
        return [...prev, ...sessionList.filter(session => !listed.has(chatKey(session)))]
      })
      setHasMoreSessions(data.data?.has_more === 1)

      // Store the session_ts of the last session for pagination
      setNextEndTs(lastSessionTs(sessionList))

      // Find user sessions that don't have account_info and need fetching
      const uidsToFetch = sessionList
        .filter(session => session.session_type === SESSION_TYPE.USER && !session.account_info?.name)
        .map(session => session.talker_id)

      // Fetch user info for those sessions
      if (uidsToFetch.length > 0) {
        fetchUserInfoBatch(uidsToFetch)
      }
    } catch (err) {
      console.error('Failed to load more sessions:', err)
    } finally {
      setLoadingMore(false)
    }
  }, [hasMoreSessions, nextEndTs, loadingMore, fetchUserInfoBatch])

  // List the customer service chats in 客服消息, newest first; null when the request fails
  const fetchCustomerServiceSessions = useCallback(async (): Promise<CustomerServiceSession[] | null> => {
    const account = customerServiceAccountRef.current
    try {
      const data = await window.electronAPI.bilibili.customerService.fetchSessions()
      // Another account signed in while this was out, and these chats are the last one's
      if (account !== customerServiceAccountRef.current) return null
      if (isErrorResponse(data) || data.code !== 0 || !data.data) {
        console.error('[usePrivateMessages] Failed to fetch customer service sessions:', data)
        return null
      }

      const list = data.data.session_list || []
      setChats(list)
      return list
    } catch (err) {
      console.error('[usePrivateMessages] Failed to fetch customer service sessions:', err)
      return null
    }
  }, [setChats])

  // Load a customer service chat, every page of it like fetchMessages does
  const fetchCustomerServiceMessages = useCallback(
    async (shop: CustomerServiceShop) => {
      const load = ++messagesLoadRef.current
      // Leaving the chat, opening it again or another account signing in drops this load, pages and all
      const stale = () => load !== messagesLoadRef.current || !isCustomerServiceOpen(shop)
      setMessagesLoading(true)
      setEmojiInfoMap({})
      // From nothing, so whatever a refresh or a send adds while the pages load is this chat's
      setMessages([])

      const pages = await fetchCustomerServicePages(shop, () => false, stale)
      if (!pages) return

      if (pages.error) {
        console.error('Failed to fetch customer service messages:', pages.error)
        toastManager.add({
          type: 'error',
          title: pages.messages.length > 0 ? '较早的消息加载失败' : '消息加载失败',
          description: pages.error,
        })
      }
      // Whatever loaded still shows: pages come newest first, so a later one failing leaves the chat readable.
      // A reply refreshed in or a message sent while they loaded is newer, so it stays.
      mergeEmojiInfos(pages.emojiInfos)
      const history = pages.messages.reverse().map(toDisplayMessage)
      setMessages(prev => mergeCustomerServiceMessages(history, prev))
      setMessagesLoading(false)
      // A reply can open the chat with Comet in the background, and then focusing the window marks it read
      if (windowFocusedRef.current && (pages.messages.length > 0 || !pages.error)) ackCustomerService(shop)
    },
    [mergeEmojiInfos, isCustomerServiceOpen, ackCustomerService]
  )

  // Add the open customer service chat's newest messages, without a spinner. It pages back until it
  // reaches what's shown, and takes the server's copy of those too (a choice the bot recorded as picked).
  // `settled` holds the ack back until the session lists refreshing alongside have landed, so the unread
  // it works out is neither taken from an older list nor overwritten by one.
  const fetchCustomerServiceMessagesQuietly = useCallback(
    async (shop: CustomerServiceShop, settled?: Promise<unknown>) => {
      const account = customerServiceAccountRef.current
      const stale = () => account !== customerServiceAccountRef.current || !isCustomerServiceOpen(shop)
      const shown = new Set(messagesRef.current.map(m => String(m.msg_key)))

      const pages = await fetchCustomerServicePages(shop, page => page.some(m => shown.has(m.msg_key)), stale)
      if (!pages) return
      if (pages.error) console.error('[usePrivateMessages] Silent customer service fetch failed:', pages.error)
      if (pages.messages.length === 0) return

      mergeEmojiInfos(pages.emojiInfos)
      const newest = pages.messages.map(toDisplayMessage).reverse()
      setMessages(prev => mergeCustomerServiceMessages(prev, newest))

      // Only mark as read if the window is focused (user is actively viewing), and nothing was missed
      if (!windowFocusedRef.current || pages.error) return
      await settled
      if (!stale()) ackCustomerService(shop)
    },
    [mergeEmojiInfos, isCustomerServiceOpen, ackCustomerService]
  )

  // Open 客服消息 on one of its chats: the one picked before if it's still listed, else the newest
  const openCustomerService = useCallback(async () => {
    setMessagesLoading(true)
    const load = ++messagesLoadRef.current

    const picked = activeCustomerServiceShopRef.current
    const list = await fetchCustomerServiceSessions()
    // While the list loaded the user may have picked a chat, opened 客服消息 again or switched account,
    // or moved on to another session, and each of those loads on its own
    if (load !== messagesLoadRef.current) return
    if (!selectedSessionRef.current || !isCustomerServiceSession(selectedSessionRef.current)) return
    const session = list?.find(s => isSameShop(getCustomerServiceShop(s), picked)) ?? list?.[0]
    // Without a list to go by, keep showing the chat picked before
    const shop = session ? getCustomerServiceShop(session) : list ? null : picked

    setActiveShop(shop)
    if (shop) {
      await fetchCustomerServiceMessages(shop)
    } else {
      setMessages([])
      setMessagesLoading(false)
    }
  }, [fetchCustomerServiceSessions, setActiveShop, fetchCustomerServiceMessages])

  // Switch 客服消息 to another of its chats
  const selectCustomerService = useCallback(
    (shop: CustomerServiceShop) => {
      if (isSameShop(activeCustomerServiceShopRef.current, shop)) return
      setActiveShop(shop)
      setMessages([])
      fetchCustomerServiceMessages(shop)
    },
    [setActiveShop, fetchCustomerServiceMessages]
  )

  // Send to a customer service chat, the open one unless given, showing the message right away
  const sendCustomerServiceMessage = useCallback(
    async (msgType: number, content: string, shop = activeCustomerServiceShopRef.current): Promise<boolean> => {
      const senderMid = userInfo?.mid
      if (!senderMid) return false
      if (!shop) {
        // 客服消息 opened with no chat to show, because its list failed or was empty
        console.error('Failed to send customer service message: no chat is open')
        toastManager.add({ type: 'error', title: '发送失败', description: NO_CUSTOMER_SERVICE_CHAT })
        return false
      }
      const account = customerServiceAccountRef.current

      // From this account only: the main process refuses it if another one signed in since (during an upload, say)
      const data = await window.electronAPI.bilibili.customerService.sendMessage({
        ...shop,
        msgType,
        content,
        senderMid,
      })

      if (isErrorResponse(data) || data.code !== 0) {
        const description = isErrorResponse(data) ? data.error : data.message
        console.error('Failed to send customer service message:', description)
        toastManager.add({
          type: 'error',
          title: '发送失败',
          description: description || '无法发送消息',
        })
        return false
      }

      // Sent, but for an account that has signed out since, so none of what's shown is its
      if (account !== customerServiceAccountRef.current) return true

      // The chat's next refresh brings the server's copy, which carries the same msg_key
      const sentMessage: BilibiliMessage = {
        sender_uid: senderMid,
        receiver_type: SESSION_TYPE.USER,
        receiver_id: 0,
        msg_type: msgType,
        content,
        msg_seqno: Date.now(),
        timestamp: Math.floor(Date.now() / 1000),
        at_uids: null,
        msg_key: data.data?.msg_key || String(Date.now()),
        msg_status: 0,
        notify_code: '',
        msg_source: 0,
        customer_service_sender: { type: CS_SENDER_TYPE.USER, name: userInfo.uname || '', face: userInfo.face || '' },
      }

      // Only into the chat it went to, which the user may have left, and only once: a refresh can bring
      // the server's copy before the send returns
      if (isCustomerServiceOpen(shop)) {
        const key = String(sentMessage.msg_key)
        setMessages(prev => (prev.some(m => String(m.msg_key) === key) ? prev : [...prev, sentMessage]))
      }
      setSessions(prev =>
        prev.map(s =>
          isCustomerServiceSession(s) ? { ...s, session_ts: Date.now() * 1000, last_msg: sentMessage } : s
        )
      )

      return true
    },
    [userInfo, isCustomerServiceOpen]
  )

  // Send what picking one of the bot's suggestions sends, like a typed message
  const sendCustomerServiceReply = useCallback(
    async (reply: CustomerServiceReply): Promise<boolean> => {
      setSendingMessage(true)
      try {
        return await sendCustomerServiceMessage(reply.msgType, reply.content)
      } catch (err) {
        console.error('Failed to send customer service reply:', err)
        toastManager.add({
          type: 'error',
          title: '发送失败',
          description: err instanceof Error ? err.message : '网络错误，请稍后重试',
        })
        return false
      } finally {
        setSendingMessage(false)
      }
    },
    [sendCustomerServiceMessage]
  )

  // For fan groups, look up the names of these messages' senders not known yet (0 is the system)
  const lookUpSenders = useCallback(
    (session: BilibiliSession, messages: BilibiliMessage[]) => {
      if (session.session_type !== SESSION_TYPE.FAN_GROUP) return
      const uids = new Set<number>()
      for (const msg of messages) {
        if (msg.sender_uid && msg.sender_uid !== userInfo?.mid && !userCacheRef.current[msg.sender_uid]) {
          uids.add(msg.sender_uid)
        }
      }
      if (uids.size > 0) fetchUserInfoBatch([...uids])
    },
    [userInfo?.mid, fetchUserInfoBatch]
  )

  /**
   * Start loading a chat's messages, overtaking the loads before it. The check it returns says whether this load
   * still decides what shows: the user may open another session (客服消息 included) while it runs, or this contact
   * under another account, and each of those loads on its own.
   */
  const beginChatLoad = useCallback((session: BilibiliSession) => {
    const load = ++messagesLoadRef.current
    return () => load === messagesLoadRef.current && isSameChat(selectedSessionRef.current, session)
  }, [])

  /** Mark a chat read on Bilibili up to `ackSeqno`, then its session in the lists */
  const markRead = useCallback(
    async (session: BilibiliSession, ackSeqno: number) => {
      try {
        await window.electronAPI.bilibili.updateAck({
          talkerId: String(session.talker_id),
          sessionType: String(session.session_type),
          ackSeqno: String(ackSeqno),
        })
        updateSession(
          s => isSameChat(s, session),
          s => ({ ...s, unread_count: 0 })
        )
      } catch (ackErr) {
        console.error('Failed to mark session as read:', ackErr)
      }
    },
    [updateSession]
  )

  const fetchMessages = useCallback(
    async (session: BilibiliSession) => {
      // 客服消息 holds chats from the customer service backend, not messages of its own
      if (isCustomerServiceSession(session)) {
        await openCustomerService()
        return
      }

      setMessagesLoading(true)
      // Clear emoji map when switching sessions
      setEmojiInfoMap({})

      const isOpen = beginChatLoad(session)

      try {
        const allMessages: BilibiliMessage[] = []
        let hasMore = true
        let endSeqno: string | undefined

        // As the account it's listed under, though another may take over meanwhile
        const mid = shownMidRef.current ?? undefined

        // Auto-load all pages
        while (hasMore) {
          const data = await window.electronAPI.bilibili.fetchMessages({
            talkerId: String(session.talker_id),
            sessionType: String(session.session_type),
            size: MESSAGES_PAGE_SIZE, // Use larger page size to reduce number of requests
            endSeqno,
            mid,
          })
          if (!isOpen()) return

          if (isErrorResponse(data)) {
            throw new Error(data.error || 'Failed to fetch messages')
          }

          if (data.code !== 0) {
            throw new Error(data.message || 'Failed to fetch messages')
          }

          const messages = data.data?.messages || []
          // Messages are returned newest first, accumulate them in that order
          allMessages.push(...messages)

          // Merge emoji infos from this response
          mergeEmojiInfos(data.data?.e_infos)

          hasMore = data.data?.has_more === 1
          if (hasMore && data.data?.min_seqno !== undefined) {
            // Use min_seqno as end_seqno to fetch older messages
            endSeqno = String(data.data.min_seqno)
          }
        }

        // Reverse to get chronological order (oldest first)
        const sortedMessages = allMessages.reverse()
        // The whole history, so catching up later starts from its newest
        syncedSeqnoRef.current = newestSeqno(sortedMessages)
        setMessages(sortedMessages)
        setMessagesLoading(false)

        // For group chats (fan groups), fetch user info for message senders
        lookUpSenders(session, sortedMessages)

        // Mark session as read in the background (doesn't block message display)
        if (session.max_seqno) await markRead(session, session.max_seqno)
      } catch (err) {
        console.error('Failed to fetch messages:', err)
        if (isOpen()) setMessagesLoading(false)
      }
    },
    [openCustomerService, beginChatLoad, mergeEmojiInfos, lookUpSenders, markRead]
  )

  /**
   * A chat's messages newer than `since`, or null when a page fails or `stop` says so, since stopping partway would
   * leave a gap. Pages back from the newest, bounded by `since` as Bilibili's web client asks, so only what came
   * since loads, until the pages reach it. With nothing held yet (`since` 0), only the newest page.
   */
  const fetchMessagesSince = useCallback(
    async (session: BilibiliSession, since: number, stop: () => boolean): Promise<FetchedMessages | null> => {
      const chat = {
        talkerId: String(session.talker_id),
        sessionType: String(session.session_type),
        size: MESSAGES_PAGE_SIZE,
        beginSeqno: since > 0 ? String(since) : undefined,
        // As the account it's listed under, so what comes merges into its own chat, whoever signs in meanwhile
        mid: shownMidRef.current ?? undefined,
      }
      const fetched: FetchedMessages = { messages: [], emojiInfos: [] }
      let endSeqno: string | undefined

      for (;;) {
        const data = await window.electronAPI.bilibili.fetchMessages({ ...chat, endSeqno })
        if (stop() || isErrorResponse(data) || data.code !== 0) return null

        const page = data.data?.messages || []
        fetched.messages.push(...page)
        fetched.emojiInfos.push(...(data.data?.e_infos || []))
        const oldest = data.data?.min_seqno ?? 0
        if (since <= 0 || data.data?.has_more !== 1 || page.length === 0 || oldest <= since) return fetched
        // A page that doesn't move back would only repeat
        if (endSeqno !== undefined && oldest >= Number(endSeqno)) return null
        endSeqno = String(oldest)
      }
    },
    []
  )

  /** Show messages fetched newer than the open chat's, merged in among them */
  const showNewMessages = useCallback(
    (session: BilibiliSession, newer: FetchedMessages) => {
      mergeEmojiInfos(newer.emojiInfos)
      if (newer.messages.length === 0) return
      setMessages(prev => mergeMessages(prev, newer.messages))
      lookUpSenders(session, newer.messages)
    },
    [mergeEmojiInfos, lookUpSenders]
  )

  /**
   * Catch a chat shown from the cache up with what came since, without a spinner. It's marked read as opening a
   * chat does: up to the newest message when any came, or when the session list counts some unread.
   */
  const catchUpChat = useCallback(
    async (session: BilibiliSession) => {
      const isOpen = beginChatLoad(session)
      const since = syncedSeqnoRef.current

      let newer: FetchedMessages | null = null
      try {
        newer = await fetchMessagesSince(session, since, () => !isOpen())
      } catch (err) {
        console.error('[usePrivateMessages] Failed to catch the chat up:', err)
      }
      // What shows stays as it was, cached, until a newer load or notification
      if (!newer) return

      const newest = newestSeqno(newer.messages, since)
      syncedSeqnoRef.current = newest
      showNewMessages(session, newer)

      if (newest === since && !session.unread_count) return
      await markRead(session, Math.max(newest, session.max_seqno || 0))
    },
    [beginChatLoad, fetchMessagesSince, showNewMessages, markRead]
  )

  // Silent fetch of new messages - no loading spinner, merges with existing messages
  const fetchMessagesQuietly = useCallback(
    async (session: BilibiliSession) => {
      const since = syncedSeqnoRef.current
      try {
        // Only while still viewing this session (prevents stale responses)
        const newer = await fetchMessagesSince(session, since, () => !isSameChat(selectedSessionRef.current, session))
        if (!newer) return
        showNewMessages(session, newer)
        if (newer.messages.length === 0) return

        const newest = newestSeqno(newer.messages, since)
        // Only a run from what's held leaves nothing missing in between
        if (since > 0) syncedSeqnoRef.current = Math.max(syncedSeqnoRef.current, newest)

        // Only mark as read if the window is focused (user is actively viewing)
        if (windowFocusedRef.current) {
          window.electronAPI.bilibili
            .updateAck({
              talkerId: String(session.talker_id),
              sessionType: String(session.session_type),
              ackSeqno: String(newest),
            })
            .catch(err => console.error('Failed to mark as read:', err))

          // Update session unread count
          updateSession(
            s => isSameChat(s, session),
            s => ({ ...s, unread_count: 0 })
          )
        }
      } catch (err) {
        console.error('[usePrivateMessages] Silent message fetch error:', err)
      }
    },
    [fetchMessagesSince, showNewMessages, updateSession]
  )

  // A chat opened before, shown as it was at once, then caught up
  const showKeptChat = useCallback(
    (session: BilibiliSession, chat: CachedChat) => {
      syncedSeqnoRef.current = chat.syncedSeqno
      setMessages(chat.messages)
      setEmojiInfoMap(chat.emojiInfoMap)
      setMessagesLoading(false)
      catchUpChat(session)
    },
    [catchUpChat]
  )

  /** Open a chat as saved on disk, before a relaunch say, or load it whole when it isn't */
  const openSavedChat = useCallback(
    async (session: BilibiliSession, mid: number) => {
      const isOpen = beginChatLoad(session)
      setMessagesLoading(true)
      const key = chatKey(session)
      const saved = await quietly('load a saved chat', () => window.electronAPI.bilibili.cache.loadChat({ mid, key }))
      // Another chat opened, or another account showed, meanwhile
      if (!isOpen() || shownMidRef.current !== mid) return
      if (!saved) {
        fetchMessages(session)
        return
      }

      const { users, ...chat } = saved
      // The names of those who wrote in it, for the ones the lists don't name
      setUserCache(prev => ({ ...users, ...prev }))
      markSaved(mid, key, chat)
      chatCache.set(mid, key, chat)
      showKeptChat(session, chat)
    },
    [chatCache, beginChatLoad, markSaved, fetchMessages, showKeptChat]
  )

  const selectSession = useCallback(
    (session: BilibiliSession, msgKey?: string) => {
      // Ahead of the render, so replies for the session left behind can tell they're stale
      selectedSessionRef.current = session
      setSelectedSession(session)
      setTargetMessage(msgKey ? { msgKey, id: ++targetIdRef.current } : null)

      // Kept per account; 客服消息's chats load their own way
      const mid = isCustomerServiceSession(session) ? null : shownMidRef.current
      const cached = mid !== null ? chatCache.get(mid, chatKey(session)) : undefined
      if (cached) {
        showKeptChat(session, cached)
        return
      }

      syncedSeqnoRef.current = 0
      setMessages([])
      if (mid !== null && useSettings.getState().keepChatsOnDevice) void openSavedChat(session, mid)
      else fetchMessages(session)
    },
    [chatCache, fetchMessages, showKeptChat, openSavedChat]
  )

  // Keep the open chat as shown, to show at once when it's opened again, from this account or on coming back to
  // it, and on disk to show at once after a relaunch. Not while it loads (nothing of it shows yet), nor 客服消息,
  // whose chats load their own way.
  useEffect(() => {
    const mid = shownMidRef.current
    if (!selectedSession || mid === null || messagesLoading || messages.length === 0) return
    if (isCustomerServiceSession(selectedSession)) return
    const key = chatKey(selectedSession)
    const chat = { messages, emojiInfoMap, syncedSeqno: syncedSeqnoRef.current }
    chatCache.set(mid, key, chat)
    if (keepOnDevice) scheduleChatSave(mid, key, chat)
  }, [chatCache, selectedSession, messages, emojiInfoMap, messagesLoading, keepOnDevice, scheduleChatSave])

  const clearSelectedSession = useCallback(() => {
    selectedSessionRef.current = null
    setSelectedSession(null)
    setTargetMessage(null)
    setMessages([])
  }, [])

  // Send message to the current session
  const sendMessage = useCallback(
    async (content: string): Promise<boolean> => {
      const senderMid = userInfo?.mid
      if (!selectedSession || !senderMid || !content.trim()) {
        return false
      }

      setSendingMessage(true)

      try {
        // Prepare the message content as JSON string
        const msgContent = JSON.stringify({ content: content.trim() })

        if (isCustomerServiceSession(selectedSession)) {
          return await sendCustomerServiceMessage(CS_MSG_TYPE.TEXT, msgContent)
        }

        const data = await window.electronAPI.bilibili.sendMessage({
          receiverId: String(selectedSession.talker_id),
          receiverType: String(selectedSession.session_type),
          msgType: '1', // Text message
          content: msgContent,
        })

        if (isErrorResponse(data)) {
          console.error('Failed to send message:', data.error)
          toastManager.add({
            type: 'error',
            title: '发送失败',
            description: data.error || '无法发送消息',
          })
          return false
        }

        if (data.code !== 0) {
          console.error('Failed to send message:', data.message)
          // Show the API error message to the user
          toastManager.add({
            type: 'error',
            title: '发送失败',
            description: data.message || '无法发送消息',
          })
          return false
        }

        // Create a local message object to add to the messages list immediately
        const newMessage: BilibiliMessage = {
          sender_uid: senderMid,
          receiver_type: selectedSession.session_type,
          receiver_id: selectedSession.talker_id,
          msg_type: 1,
          content: msgContent,
          msg_seqno: Date.now(), // Use timestamp as temporary seqno
          timestamp: Math.floor(Date.now() / 1000),
          at_uids: null,
          msg_key: data.data?.msg_key || Date.now(),
          msg_status: 0,
          notify_code: '',
          new_face_version: 1,
          msg_source: 7, // Web
        }

        // Add the new message to the messages list, if it's still the chat open: the user may have opened
        // another while it sent, and that one's messages are kept for opening it again
        if (isSameChat(selectedSessionRef.current, selectedSession)) setMessages(prev => [...prev, newMessage])

        // Update the session's last_msg and session_ts
        updateSession(
          s => isSameChat(s, selectedSession),
          s => ({
            ...s,
            session_ts: Date.now() * 1000, // Microsecond timestamp
            last_msg: {
              sender_uid: senderMid,
              receiver_type: selectedSession.session_type,
              receiver_id: selectedSession.talker_id,
              msg_type: 1,
              content: msgContent,
              msg_seqno: newMessage.msg_seqno,
              timestamp: newMessage.timestamp,
              at_uids: null,
              msg_key: newMessage.msg_key,
              msg_status: 0,
              notify_code: '',
              new_face_version: 1,
              msg_source: 7,
            },
          })
        )

        return true
      } catch (err) {
        console.error('Failed to send message:', err)
        toastManager.add({
          type: 'error',
          title: '发送失败',
          description: err instanceof Error ? err.message : '网络错误，请稍后重试',
        })
        return false
      } finally {
        setSendingMessage(false)
      }
    },
    [selectedSession, userInfo, sendCustomerServiceMessage, updateSession]
  )

  // Recall a message by sending a msg_type=5 message with the target msg_key
  // We use msgSeqno for local state update (reliable number) and msgKeyStr for the API (string to avoid precision loss)
  const recallMessage = useCallback(
    async (msgSeqno: number, msgKeyStr: string): Promise<{ success: boolean; error?: string }> => {
      const senderMid = userInfo?.mid
      if (!selectedSession || !senderMid) {
        return { success: false, error: '无法撤回消息' }
      }
      // Customer service has no recall, as in Bilibili's own client
      if (isCustomerServiceSession(selectedSession)) {
        return { success: false, error: '客服消息不支持撤回' }
      }

      try {
        // Send a recall message (msg_type=5) with the target msg_key as content
        // According to the API doc, the content is just the msg_key number (not JSON)
        // We use msgKeyStr (string) to avoid JavaScript number precision loss with large integers
        const data = await window.electronAPI.bilibili.sendMessage({
          receiverId: String(selectedSession.talker_id),
          receiverType: String(selectedSession.session_type),
          msgType: '5', // Recall message type
          content: msgKeyStr,
        })

        if (isErrorResponse(data)) {
          console.error('Failed to recall message:', data.error)
          return { success: false, error: data.error || '撤回失败' }
        }

        if (data.code !== 0) {
          console.error('Failed to recall message:', data.message)
          // Return the server's error message for display
          return { success: false, error: data.message || '撤回失败' }
        }

        // Another chat opened meanwhile, whose messages the seqno doesn't name (and which the cache would keep).
        // This one shows the recall once it's opened again, catching up on the recall message.
        if (!isSameChat(selectedSessionRef.current, selectedSession)) return { success: true }

        // Update the local message to show as recalled (msg_status = 1)
        // Use msgSeqno for comparison as it's a smaller number without precision issues
        setMessages(prev =>
          prev.map(m => {
            if (m.msg_seqno === msgSeqno) {
              return { ...m, msg_status: 1 }
            }
            return m
          })
        )

        return { success: true }
      } catch (err) {
        console.error('Failed to recall message:', err)
        return { success: false, error: '撤回失败' }
      }
    },
    [selectedSession, userInfo]
  )

  // Toggle Do Not Disturb for a session
  const toggleDnd = useCallback(
    async (session: BilibiliSession, enabled: boolean): Promise<boolean> => {
      try {
        if (isCustomerServiceSession(session)) {
          // set_msg_dnd needs a talker uid, which 客服消息 lacks, and customer service only offers
          // Do Not Disturb per store, so Comet keeps this session's setting itself
          if (!userInfo?.mid) return false
          useSettings.getState().setCustomerServiceMuted(userInfo.mid, enabled)
        } else {
          const result = await window.electronAPI.bilibili.setDnd({
            dndUid: session.session_type === SESSION_TYPE.USER ? session.talker_id : undefined,
            dndGroupId: session.session_type === SESSION_TYPE.FAN_GROUP ? session.talker_id : undefined,
            sessionType: session.session_type,
            enabled,
          })

          if (!result.success) {
            console.error('Failed to toggle DND:', result.error)
            toastManager.add({
              type: 'error',
              title: '操作失败',
              description: result.error || '无法更改免打扰设置',
            })
            return false
          }
        }

        // Update the session in the sessions list
        updateSession(
          s => s.talker_id === session.talker_id && s.session_type === session.session_type,
          s => ({ ...s, is_dnd: enabled ? 1 : 0 })
        )

        // Also update the selected session if it matches
        setSelectedSession(prev => {
          if (prev?.talker_id === session.talker_id && prev?.session_type === session.session_type) {
            return { ...prev, is_dnd: enabled ? 1 : 0 }
          }
          return prev
        })

        return true
      } catch (err) {
        console.error('Failed to toggle DND:', err)
        toastManager.add({
          type: 'error',
          title: '操作失败',
          description: '无法更改免打扰设置',
        })
        return false
      }
    },
    [userInfo?.mid, updateSession]
  )

  // Toggle sticky (pin/unpin) for a session
  const toggleSticky = useCallback(
    async (session: BilibiliSession, pinned: boolean): Promise<boolean> => {
      try {
        const result = await window.electronAPI.bilibili.setTop({
          talkerId: session.talker_id,
          sessionType: session.session_type,
          pinned,
        })

        if (!result.success) {
          console.error('Failed to toggle sticky:', result.error)
          toastManager.add({
            type: 'error',
            title: '操作失败',
            description: result.error || '无法更改置顶设置',
          })
          return false
        }

        // Update the session in the sessions list
        updateSession(
          s => s.talker_id === session.talker_id && s.session_type === session.session_type,
          s => ({ ...s, top_ts: pinned ? Date.now() * 1000 : 0 })
        )

        // Also update the selected session if it matches
        setSelectedSession(prev => {
          if (prev?.talker_id === session.talker_id && prev?.session_type === session.session_type) {
            return { ...prev, top_ts: pinned ? Date.now() * 1000 : 0 }
          }
          return prev
        })

        return true
      } catch (err) {
        console.error('Failed to toggle sticky:', err)
        toastManager.add({
          type: 'error',
          title: '操作失败',
          description: '无法更改置顶设置',
        })
        return false
      }
    },
    [updateSession]
  )

  // Send image message to the current session
  const sendImageMessage = useCallback(
    async (imageData: string, mimeType: string): Promise<boolean> => {
      const senderMid = userInfo?.mid
      if (!selectedSession || !senderMid || !imageData) {
        return false
      }

      setSendingMessage(true)

      try {
        // First, upload the image to Bilibili CDN (customer service takes uploads of its own).
        // A customer service image goes to the chat open now, so there must be one before uploading.
        const isCustomerService = isCustomerServiceSession(selectedSession)
        const customerServiceShop = activeCustomerServiceShopRef.current
        if (isCustomerService && !customerServiceShop) {
          toastManager.add({ type: 'error', title: '图片发送失败', description: NO_CUSTOMER_SERVICE_CHAT })
          return false
        }
        const upload = isCustomerService
          ? window.electronAPI.bilibili.customerService.uploadImage
          : window.electronAPI.bilibili.uploadImage
        const uploadResult = await upload({
          imageData,
          mimeType,
        })

        if (!uploadResult.success || !uploadResult.url) {
          console.error('Failed to upload image:', uploadResult.error)
          toastManager.add({
            type: 'error',
            title: '图片上传失败',
            description: uploadResult.error || '请检查图片格式和尺寸是否符合要求',
          })
          return false
        }

        // Determine image type from mimeType
        const imageType = getImageType(mimeType)

        // Prepare the image message content
        const msgContent = JSON.stringify({
          url: uploadResult.url,
          height: uploadResult.height || 0,
          width: uploadResult.width || 0,
          imageType,
          original: 1,
          size: Math.round((imageData.length * 3) / 4 / 1024), // Approximate size in KB from base64
        })

        if (isCustomerService) {
          return await sendCustomerServiceMessage(CS_MSG_TYPE.IMAGE, msgContent, customerServiceShop)
        }

        const data = await window.electronAPI.bilibili.sendMessage({
          receiverId: String(selectedSession.talker_id),
          receiverType: String(selectedSession.session_type),
          msgType: '2', // Image message
          content: msgContent,
        })

        if (isErrorResponse(data)) {
          console.error('Failed to send image message:', data.error)
          toastManager.add({
            type: 'error',
            title: '图片发送失败',
            description: data.error,
          })
          return false
        }

        if (data.code !== 0) {
          console.error('Failed to send image message:', data.message)
          toastManager.add({
            type: 'error',
            title: '图片发送失败',
            description: data.message || '请稍后重试',
          })
          return false
        }

        // Create a local message object to add to the messages list immediately
        const newMessage: BilibiliMessage = {
          sender_uid: senderMid,
          receiver_type: selectedSession.session_type,
          receiver_id: selectedSession.talker_id,
          msg_type: 2, // Image message
          content: msgContent,
          msg_seqno: Date.now(),
          timestamp: Math.floor(Date.now() / 1000),
          at_uids: null,
          msg_key: data.data?.msg_key || Date.now(),
          msg_status: 0,
          notify_code: '',
          new_face_version: 1,
          msg_source: 7, // Web
        }

        // Add the new message to the messages list, if it's still the chat open: the user may have opened
        // another while it sent, and that one's messages are kept for opening it again
        if (isSameChat(selectedSessionRef.current, selectedSession)) setMessages(prev => [...prev, newMessage])

        // Update the session's last_msg and session_ts
        updateSession(
          s => isSameChat(s, selectedSession),
          s => ({
            ...s,
            session_ts: Date.now() * 1000,
            last_msg: {
              sender_uid: senderMid,
              receiver_type: selectedSession.session_type,
              receiver_id: selectedSession.talker_id,
              msg_type: 2,
              content: msgContent,
              msg_seqno: newMessage.msg_seqno,
              timestamp: newMessage.timestamp,
              at_uids: null,
              msg_key: newMessage.msg_key,
              msg_status: 0,
              notify_code: '',
              new_face_version: 1,
              msg_source: 7,
            },
          })
        )

        return true
      } catch (err) {
        console.error('Failed to send image message:', err)
        return false
      } finally {
        setSendingMessage(false)
      }
    },
    [selectedSession, userInfo, sendCustomerServiceMessage, updateSession]
  )

  // Connect to WebSocket for real-time notifications
  const connectWebSocket = useCallback(async () => {
    try {
      await window.electronAPI.bilibili.wsConnect()
      console.log('[usePrivateMessages] WebSocket connection initiated')
    } catch (err) {
      console.error('[usePrivateMessages] Failed to connect WebSocket:', err)
    }
  }, [])

  // Disconnect WebSocket
  const disconnectWebSocket = useCallback(async () => {
    try {
      await window.electronAPI.bilibili.wsDisconnect()
      setWsConnected(false)
      console.log('[usePrivateMessages] WebSocket disconnected')
    } catch (err) {
      console.error('[usePrivateMessages] Failed to disconnect WebSocket:', err)
    }
  }, [])

  // Fetch all stored accounts, resolving to them, or to null when that fails
  const fetchAccounts = useCallback(async (): Promise<GetAccountsResult | null> => {
    try {
      const result = await window.electronAPI.bilibili.getAccounts()
      setAccounts(result.accounts)
      setActiveAccountMid(result.activeAccountMid)
      return result
    } catch (err) {
      console.error('[usePrivateMessages] Failed to fetch accounts:', err)
      return null
    }
  }, [])

  /** Switch to a different stored account and reload its sessions and WebSocket connection */
  const switchAccount = useCallback(
    async (mid: number) => {
      explicitAccountActionsRef.current++
      authCheckSeqRef.current++
      const transitionId = beginAccountTransition()
      let accountSwitched = false
      // Its lists as saved on disk, unless they're kept here already, read while the switch goes through
      const saved = snapshots.has(mid) ? null : loadSavedLists(mid)
      const restorePreviousWebSocket = async () => {
        if (endAccountTransition(transitionId) && connectedMidRef.current !== null) {
          try {
            await window.electronAPI.bilibili.wsConnect()
          } catch (wsErr) {
            console.error('[usePrivateMessages] Failed to restore WebSocket:', wsErr)
          }
        }
      }

      try {
        // Disconnect current WebSocket first
        await window.electronAPI.bilibili.wsDisconnect()
        if (activeTransitionIdRef.current !== transitionId) return
        setWsConnected(false)

        // Switch the active account
        const result = await window.electronAPI.bilibili.setActiveAccount({ mid })
        authCheckSeqRef.current++
        if (activeTransitionIdRef.current !== transitionId) return
        if (!result.success) {
          console.error('[usePrivateMessages] Failed to switch account')
          await restorePreviousWebSocket()
          return
        }
        const lists = await saved
        if (activeTransitionIdRef.current !== transitionId) return
        if (lists && !snapshots.has(mid)) snapshots.set(mid, lists)

        // Record the committed switch, keeping what this account shows for coming back to it. The next one shows
        // as last seen while its login is checked and its lists refresh: who it is, and its lists if it has a
        // snapshot (loaded in the background, saved on disk, or from when it was last shown).
        accountSwitched = true
        setActiveAccountMid(mid)
        connectedMidRef.current = null
        rememberShownAccount()
        const account = accountsRef.current.find(a => a.mid === mid)
        setUserInfo(account ? storedLogin(account) : null)
        resetAccountState()
        showAccount(mid)
        initialLoadFailedRef.current = true

        await reconcileCommittedAccount(transitionId)
      } catch (err) {
        console.error('[usePrivateMessages] Failed to switch account:', err)
        if (!accountSwitched) {
          await restorePreviousWebSocket()
        }
      } finally {
        endAccountTransition(transitionId)
        explicitAccountActionsRef.current--
      }
    },
    [
      snapshots,
      loadSavedLists,
      resetAccountState,
      rememberShownAccount,
      showAccount,
      beginAccountTransition,
      endAccountTransition,
      reconcileCommittedAccount,
    ]
  )

  /**
   * At launch, show the active account as it was last shown, from disk, while its login is checked and its lists
   * refresh, as switching to it does. False, leaving the launch to check the login as before, when nothing's saved
   * to show, or when a login check or an account action got there first.
   */
  const resumeSavedAccount = useCallback(
    async ({ accounts: stored, activeAccountMid }: GetAccountsResult): Promise<boolean> => {
      const account = stored.find(a => a.mid === activeAccountMid)
      if (!account || account.isExpired) return false
      const lists = await loadSavedLists(account.mid)
      if (
        !lists ||
        !mountedRef.current ||
        explicitAccountActionsRef.current > 0 ||
        connectedMidRef.current !== null ||
        shownMidRef.current !== null
      ) {
        return false
      }

      explicitAccountActionsRef.current++
      // A login check out already lands on nothing: this one checks again
      authCheckSeqRef.current++
      const transitionId = beginAccountTransition()
      try {
        snapshots.set(account.mid, lists)
        setUserInfo(storedLogin(account))
        showAccount(account.mid)
        setIsConnected(true)
        setInitializing(false)
        // Reconnecting loads the lists again if they don't refresh
        initialLoadFailedRef.current = true
        await reconcileCommittedAccount(transitionId)
      } catch (err) {
        console.error('[usePrivateMessages] Failed to check the account shown at launch:', err)
      } finally {
        endAccountTransition(transitionId)
        explicitAccountActionsRef.current--
      }
      return true
    },
    [snapshots, loadSavedLists, showAccount, beginAccountTransition, endAccountTransition, reconcileCommittedAccount]
  )

  /** Remove a stored account by mid and switch or reset state when removing the active account */
  const removeAccountFn = useCallback(
    async (mid: number) => {
      explicitAccountActionsRef.current++
      authCheckSeqRef.current++
      const wasActiveAccount = mid === activeAccountMid
      const transitionId = wasActiveAccount ? beginAccountTransition() : null
      let accountRemoved = false

      try {
        // If removing the active account, disconnect WS first
        if (wasActiveAccount) {
          await window.electronAPI.bilibili.wsDisconnect()
          if (transitionId !== null && activeTransitionIdRef.current !== transitionId) return
          setWsConnected(false)
        }

        const result = await window.electronAPI.bilibili.removeAccount({ mid })
        authCheckSeqRef.current++
        if (result.success) {
          accountRemoved = true
          useDrafts.getState().clearAccountDrafts(mid)
          forgetAccount(mid)
          if (transitionId !== null && activeTransitionIdRef.current !== transitionId) return
          setAccounts(result.remainingAccounts)
          setActiveAccountMid(result.activeAccountMid)

          // If we removed the active account, clear its state immediately and reconcile with the new active account
          if (wasActiveAccount) {
            connectedMidRef.current = null
            setUserInfo(null)
            resetAccountState()
            if (result.activeAccountMid && transitionId !== null) {
              initialLoadFailedRef.current = true
              await reconcileCommittedAccount(transitionId)
            } else {
              setIsConnected(false)
            }
          }
        } else {
          // Removal failed - reconnect WebSocket if we disconnected it
          if (transitionId !== null && endAccountTransition(transitionId)) {
            await window.electronAPI.bilibili.wsConnect()
          }
        }
      } catch (err) {
        console.error('[usePrivateMessages] Failed to remove account:', err)
        // Reconnect WebSocket only if the active account was not removed before the error
        if (!accountRemoved && transitionId !== null && endAccountTransition(transitionId)) {
          try {
            await window.electronAPI.bilibili.wsConnect()
          } catch (wsErr) {
            console.error('[usePrivateMessages] Failed to reconnect WebSocket:', wsErr)
          }
        }
      } finally {
        if (transitionId !== null) {
          endAccountTransition(transitionId)
        }
        explicitAccountActionsRef.current--
      }
    },
    [
      activeAccountMid,
      resetAccountState,
      forgetAccount,
      beginAccountTransition,
      endAccountTransition,
      reconcileCommittedAccount,
    ]
  )

  // Start adding a new account (shows QR dialog)
  const startAddingAccount = useCallback(() => {
    setIsAddingAccount(true)
  }, [])

  // Cancel adding account
  const cancelAddingAccount = useCallback(() => {
    setIsAddingAccount(false)
  }, [])

  // Called when a new account is successfully added
  const onAccountAdded = useCallback(async () => {
    setIsAddingAccount(false)
    // Refresh accounts list
    await fetchAccounts()
    // Check login to get the new user info (the new account becomes active)
    await checkLogin()
    // Fetch sessions for the new account
    await fetchSessions()
  }, [fetchAccounts, checkLogin, fetchSessions])

  // Start re-authenticating an expired account (shows QR dialog in reauth mode)
  const startReauthAccount = useCallback(
    (mid: number) => {
      const account = accounts.find(a => a.mid === mid)
      if (account) {
        setReauthAccount(account)
        setIsAddingAccount(true) // Reuse the same dialog, but in reauth mode
      }
    },
    [accounts]
  )

  // Cancel re-authentication
  const cancelReauthAccount = useCallback(() => {
    setReauthAccount(null)
    setIsAddingAccount(false)
  }, [])

  // Called when re-authentication is successful
  const onReauthSuccess = useCallback(async () => {
    const reauthMid = reauthAccount?.mid
    setReauthAccount(null)
    setIsAddingAccount(false)

    // Refresh accounts list to clear expired status
    await fetchAccounts()

    // If the re-authenticated account was the active one, refresh the session
    if (reauthMid === activeAccountMid) {
      await checkLogin()
      await fetchSessions()
      // Reconnect WebSocket
      await window.electronAPI.bilibili.wsConnect()
    }
  }, [reauthAccount, activeAccountMid, fetchAccounts, checkLogin, fetchSessions])

  // Reorder accounts (for keyboard shortcut ordering)
  // Returns true on success, false on failure (for rollback support)
  const reorderAccountsFn = useCallback(async (mids: number[]): Promise<boolean> => {
    try {
      const result = await window.electronAPI.bilibili.reorderAccounts({ mids })
      if (result.success) {
        setAccounts(result.accounts)
        setActiveAccountMid(result.activeAccountMid)
        return true
      }
      console.error('[usePrivateMessages] Reorder accounts failed: success=false')
      return false
    } catch (err) {
      console.error('[usePrivateMessages] Failed to reorder accounts:', err)
      return false
    }
  }, [])

  // Silent background refresh of sessions - no loading spinner
  // Returns the fetched sessions for immediate use (avoids race condition with ref sync)
  const refreshSessionsQuietly = useCallback(async (): Promise<BilibiliSession[]> => {
    const load = listsLoadRef.current
    const fold = unfollowFoldRef.current
    try {
      const data = await window.electronAPI.bilibili.fetchSessions({ unfollowFold: fold })

      if (isErrorResponse(data) || data.code !== 0) {
        console.error('[usePrivateMessages] Silent session refresh failed')
        return []
      }

      const sessionList = data.data?.session_list || []
      // A full load, another account or the fold setting changing overtook it: only lookups use what it fetched
      if (load !== listsLoadRef.current || fold !== unfollowFoldRef.current) return sessionList

      // The pages loaded past the first stay where they still follow on from it, so a message doesn't take the list
      // scrolled or searched through back to its first page
      showSessionsPage(sessionList, firstPageGoesOn(data, fold), true)

      // Fetch user info for new sessions, the ones not known already
      const uidsToFetch = sessionList
        .filter(
          session =>
            session.session_type === SESSION_TYPE.USER &&
            !session.account_info?.name &&
            !userCacheRef.current[session.talker_id]
        )
        .map(session => session.talker_id)

      if (uidsToFetch.length > 0) {
        fetchUserInfoBatch(uidsToFetch)
      }

      return sessionList
    } catch (err) {
      console.error('[usePrivateMessages] Silent session refresh error:', err)
      return []
    }
  }, [showSessionsPage, fetchUserInfoBatch])

  // Fetch latest message for notification purposes (when instantMsg not available)
  const fetchLatestMessageForNotification = useCallback(
    async (talkerId: number, sessionType: number, refreshedSessions: Promise<BilibiliSession[]>) => {
      try {
        const data = await window.electronAPI.bilibili.fetchMessages({
          talkerId: String(talkerId),
          sessionType: String(sessionType),
          size: '1', // Only need the latest message
        })

        if (isErrorResponse(data) || data.code !== 0) return

        const messages = data.data?.messages || []
        if (messages.length > 0) {
          const latestMsg = messages[0] // Newest message is first
          showNotificationForMessage(latestMsg, latestMsg.sender_uid, talkerId, sessionType, refreshedSessions)
        }
      } catch (err) {
        console.error('[usePrivateMessages] Failed to fetch message for notification:', err)
      }
    },
    [showNotificationForMessage]
  )

  // msg_key of the customer service message last notified about, per chat
  const notifiedCustomerServiceKeysRef = useRef(new Map<string, string>())

  // Customer service notifications also arrive for the user's own messages and name only the chat,
  // so that chat's latest message decides: notify once for an unread one somebody else sent
  const showCustomerServiceNotification = useCallback(
    async (
      shop: CustomerServiceShop,
      chats: Promise<CustomerServiceSession[] | null>,
      refreshedSessions: Promise<BilibiliSession[]>
    ) => {
      const account = customerServiceAccountRef.current
      const mid = userInfo?.mid
      const list = await chats
      // A chat past the listed ones is likely the newest, which lists first
      const chat = list?.find(s => isSameShop(getCustomerServiceShop(s), shop)) ?? list?.[0]
      const latest = chat?.last_msg
      if (!chat || !latest || !chat.unread_info?.unread_count) return
      if (latest.sender_info?.type === CS_SENDER_TYPE.USER || latest.msg_type === CS_MSG_TYPE.WITHDRAW) return

      // Several notifications can arrive for one message (the user's own just before a reply, say),
      // with another chat's between them
      const { shopFatherId, shopId } = getCustomerServiceShop(chat)
      const notified = notifiedCustomerServiceKeysRef.current
      if (notified.get(`${shopFatherId}_${shopId}`) === latest.msg_key) return
      notified.set(`${shopFatherId}_${shopId}`, latest.msg_key)

      const session =
        (await refreshedSessions).find(isCustomerServiceSession) ?? sessionsRef.current.find(isCustomerServiceSession)
      // The user may have muted 客服消息, or switched account, while the lists loaded
      if (account !== customerServiceAccountRef.current) return
      const muted = mid !== undefined && useSettings.getState().customerServiceMutedMids.includes(mid)
      if (session?.is_dnd === 1 || muted) {
        console.log('[usePrivateMessages] Notification suppressed for muted customer service session')
        return
      }

      try {
        const result = await window.electronAPI.bilibili.showNotification({
          title: session ? getSessionName(session) : '客服消息',
          body: getCustomerServicePreview(latest) || '[新消息]',
          icon: (session && getSessionAvatar(session)) || undefined,
          talkerId: session?.talker_id ?? 0,
          sessionType: session?.session_type ?? SESSION_TYPE.USER,
          // Clicking it opens 客服消息 on this chat
          customerServiceShop: getCustomerServiceShop(chat),
        })
        console.log('[usePrivateMessages] Notification result:', result)
      } catch (err) {
        console.error('[usePrivateMessages] Failed to show notification:', err)
      }
    },
    [userInfo?.mid]
  )

  // Handle new message notification - uses incremental update, no spinners
  const handleNewMessage = useCallback(
    (notification: NewMessageNotification) => {
      console.log('[usePrivateMessages] New message notification:', notification)

      // Silent background refresh to get the authoritative sort order from the server
      // (respects sticky sessions, custom sorting, new conversations, etc.).
      // Notifications reuse it to look up sessions that aren't in state yet.
      const refreshedSessions = refreshSessionsQuietly()

      // Customer service chats run on their own backend and only appear folded into 客服消息
      if (CUSTOMER_SERVICE_WS_SESSION_TYPES.has(notification.sessionType)) {
        const chats = fetchCustomerServiceSessions()
        showCustomerServiceNotification(getNotifiedShop(notification), chats, refreshedSessions)

        // With 客服消息 open, refresh the chat on screen; its ack waits for both lists, whose unread it
        // updates. With no chat on screen (the list was empty or failed), open the newest one.
        const open = selectedSessionRef.current
        if (open && isCustomerServiceSession(open)) {
          const shop = activeCustomerServiceShopRef.current
          if (shop) {
            fetchCustomerServiceMessagesQuietly(shop, Promise.all([refreshedSessions, chats]))
          } else {
            chats.then(list => {
              const now = selectedSessionRef.current
              if (!list?.[0] || activeCustomerServiceShopRef.current || !now || !isCustomerServiceSession(now)) return
              const newest = getCustomerServiceShop(list[0])
              setActiveShop(newest)
              fetchCustomerServiceMessages(newest)
            })
          }
        }
        return
      }

      // A chat the main list doesn't have may be folded into 未关注人消息, which then refreshes too, so
      // notifications can look it up there
      const isNotifiedSession = (s: BilibiliSession) =>
        s.talker_id === notification.talkerId && s.session_type === notification.sessionType
      const refreshedChats = refreshedSessions.then(async list =>
        list.some(isNotifiedSession) || !unfollowFoldRef.current
          ? list
          : [...list, ...(await refreshUnfollowedQuietly())]
      )

      const isCurrentSession =
        selectedSession?.talker_id === notification.talkerId &&
        selectedSession?.session_type === notification.sessionType

      const isWindowFocused = windowFocusedRef.current

      // If the notification is for the currently selected session
      if (isCurrentSession) {
        if (notification.instantMsg) {
          // If we have instant message data, append it directly (no refetch, no spinner)
          const instantMsg = notification.instantMsg
          const newMessage: BilibiliMessage = {
            sender_uid: instantMsg.senderUid,
            receiver_type: instantMsg.receiverType,
            receiver_id: instantMsg.receiverId,
            msg_type: instantMsg.msgType,
            content: instantMsg.content,
            msg_seqno: instantMsg.msgSeqno,
            timestamp: instantMsg.timestamp,
            at_uids: null,
            msg_key: instantMsg.msgKey,
            msg_status: 0,
            notify_code: '',
            new_face_version: 1,
            msg_source: 1, // From notification
          }

          // Add the new message only if it doesn't already exist (avoid duplicates). A recall takes back the
          // message it names, as loading the chat again would show.
          setMessages(prev =>
            prev.some(m => m.msg_seqno === newMessage.msg_seqno) ? prev : mergeMessages(prev, [newMessage])
          )

          // Only mark as read if the window is focused (user is actively viewing)
          if (isWindowFocused && selectedSession.max_seqno) {
            window.electronAPI.bilibili
              .updateAck({
                talkerId: String(selectedSession.talker_id),
                sessionType: String(selectedSession.session_type),
                ackSeqno: String(notification.latestSeqno || selectedSession.max_seqno),
              })
              .catch(err => console.error('Failed to mark as read:', err))
          }

          // Show notification (main process will suppress if window is focused)
          showNotificationForMessage(
            newMessage,
            instantMsg.senderUid,
            notification.talkerId,
            notification.sessionType,
            refreshedChats
          )
        } else {
          // No instant message data available - do a silent fetch to get new messages
          fetchMessagesQuietly(selectedSession)

          // When window is not focused, also show a notification (fetch the latest message for it)
          if (!isWindowFocused) {
            fetchLatestMessageForNotification(notification.talkerId, notification.sessionType, refreshedChats)
          }
        }
      } else {
        // Not the current session - show system notification
        if (notification.instantMsg) {
          // We have the message data, show notification immediately
          const instantMsg = notification.instantMsg
          const tempMessage: BilibiliMessage = {
            sender_uid: instantMsg.senderUid,
            receiver_type: instantMsg.receiverType,
            receiver_id: instantMsg.receiverId,
            msg_type: instantMsg.msgType,
            content: instantMsg.content,
            msg_seqno: instantMsg.msgSeqno,
            timestamp: instantMsg.timestamp,
            at_uids: null,
            msg_key: instantMsg.msgKey,
            msg_status: 0,
            notify_code: '',
            new_face_version: 1,
            msg_source: 1,
          }
          showNotificationForMessage(
            tempMessage,
            instantMsg.senderUid,
            notification.talkerId,
            notification.sessionType,
            refreshedChats
          )
        } else {
          // No instant message data - fetch the latest message for notification
          fetchLatestMessageForNotification(notification.talkerId, notification.sessionType, refreshedChats)
        }
      }

      // Update session list to reflect new messages (optimistic in-place update), wherever it's listed
      updateSession(isNotifiedSession, listed => {
        const session = { ...listed }

        // Update unread count: only reset to 0 if this is the current session AND window is focused
        if (isCurrentSession && isWindowFocused) {
          session.unread_count = 0
        } else {
          session.unread_count = (session.unread_count || 0) + 1
        }

        // Update last_msg if we have instant message data
        if (notification.instantMsg) {
          const instantMsg = notification.instantMsg
          session.last_msg = {
            sender_uid: instantMsg.senderUid,
            receiver_type: instantMsg.receiverType,
            receiver_id: instantMsg.receiverId,
            msg_type: instantMsg.msgType,
            content: instantMsg.content,
            msg_seqno: instantMsg.msgSeqno,
            timestamp: instantMsg.timestamp,
            at_uids: null,
            msg_key: instantMsg.msgKey,
            msg_status: 0,
            notify_code: '',
            new_face_version: 1,
            msg_source: 1,
          }
        }

        // Update max_seqno so ack calls use the latest value
        if (notification.latestSeqno) {
          session.max_seqno = notification.latestSeqno
        }

        // Update session in place — preserve server sort order (sticky sessions, etc.)
        return session
      })

      // Keep selectedSession in sync so handleFocus and other consumers see the latest max_seqno
      if (isCurrentSession && notification.latestSeqno) {
        const newSeqno = notification.latestSeqno
        setSelectedSession(prev => {
          if (prev?.talker_id === notification.talkerId && prev?.session_type === notification.sessionType) {
            return { ...prev, max_seqno: newSeqno }
          }
          return prev
        })
      }
    },
    [
      selectedSession,
      refreshSessionsQuietly,
      showCustomerServiceNotification,
      fetchCustomerServiceSessions,
      fetchCustomerServiceMessagesQuietly,
      setActiveShop,
      fetchCustomerServiceMessages,
      fetchMessagesQuietly,
      showNotificationForMessage,
      fetchLatestMessageForNotification,
      refreshUnfollowedQuietly,
      updateSession,
    ]
  )

  // Handle session update notification - uses silent refresh, no spinners
  const handleSessionUpdate = useCallback(
    (notification: SessionUpdateNotification) => {
      console.log('[usePrivateMessages] Session update notification:', notification)

      switch (notification.type) {
        case 'session_list': {
          // Silent background refresh - no spinner
          refreshSessionsQuietly()
          // A chat the main list doesn't have, changed by a pin or Do Not Disturb set on another client, say, may
          // be one of 未关注人消息's, loaded or not
          const uid = notification.sessionId?.privateId?.uid
          const listed = sessionsRef.current.some(s => s.session_type === SESSION_TYPE.USER && s.talker_id === uid)
          if (unfollowFoldRef.current && uid && !listed) refreshUnfollowedQuietly()
          break
        }
        case 'total_unread':
          refreshSessionsQuietly()
          // Reading 未关注人消息's chats elsewhere changes their unread and its count, which refresh together
          if (unfollowFoldRef.current) refreshUnfollowedQuietly()
          break
        case 'fetch_message':
          // For fetch_message, we don't need to do a full refetch since
          // handleNewMessage already appends the message directly.
          // This is just a hint that there are new messages, which we've already handled.
          break
      }
    },
    [refreshSessionsQuietly, refreshUnfollowedQuietly]
  )

  // Check login status and fetch accounts on mount, showing the active account as saved on disk meanwhile
  const initStartedRef = useRef(false)
  useEffect(() => {
    // Once, though StrictMode runs effects twice in development
    if (initStartedRef.current) return
    initStartedRef.current = true
    const init = async () => {
      const stored = await fetchAccounts()
      if (!stored || !(await resumeSavedAccount(stored))) await checkLogin()
      setInitializing(false)
    }
    init()
  }, [checkLogin, fetchAccounts, resumeSavedAccount])

  // Set up WebSocket event listeners
  useEffect(() => {
    // Set up event listeners
    const cleanupNewMessage = window.electronAPI.bilibili.onNewMessage(handleNewMessage)
    const cleanupSessionUpdate = window.electronAPI.bilibili.onSessionUpdate(handleSessionUpdate)
    const cleanupWsConnected = window.electronAPI.bilibili.onWsConnected(() => {
      console.log('[usePrivateMessages] WebSocket connected')
      setWsConnected(true)
      if (connectedMidRef.current !== null && initialLoadFailedRef.current) {
        fetchSessions()
      }
    })
    const cleanupWsDisconnected = window.electronAPI.bilibili.onWsDisconnected(() => {
      console.log('[usePrivateMessages] WebSocket disconnected')
      setWsConnected(false)
    })

    // Cleanup on unmount
    return () => {
      cleanupNewMessage()
      cleanupSessionUpdate()
      cleanupWsConnected()
      cleanupWsDisconnected()
    }
  }, [handleNewMessage, handleSessionUpdate, fetchSessions])

  // Handle navigation from notification clicks
  useEffect(() => {
    const handleNavigateToSession = async (params: NavigateToSessionParams) => {
      console.log('[usePrivateMessages] Navigate to session received:', params)
      console.log('[usePrivateMessages] Current sessions count:', sessionsRef.current.length)

      // Find the session in the current lists
      const isTargetSession = (s: BilibiliSession) =>
        s.talker_id === params.talkerId && s.session_type === params.sessionType
      let session = findListedSession(isTargetSession)

      console.log('[usePrivateMessages] Found session in ref:', session ? 'yes' : 'no')

      if (!session) {
        // Session not in list yet - refresh sessions first
        console.log('[usePrivateMessages] Session not found, refreshing sessions first...')
        const refreshedSessions = await refreshSessionsQuietly()

        // Use the returned sessions directly (avoids race condition with ref sync)
        session = refreshedSessions.find(isTargetSession)
        // Missing from the main list, it may be folded into 未关注人消息
        if (!session && unfollowFoldRef.current) session = (await refreshUnfollowedQuietly()).find(isTargetSession)
        console.log('[usePrivateMessages] After refresh, found session:', session ? 'yes' : 'no')
      }

      if (session) {
        // Select the session (this will fetch messages and mark as read), and for 客服消息 the chat
        // the notification was for
        console.log('[usePrivateMessages] Selecting session:', session.talker_id)
        if (params.customerServiceShop && isCustomerServiceSession(session)) setActiveShop(params.customerServiceShop)
        // A folded chat opens beside 未关注人消息's list, where it's listed
        if (isFolded(session)) setUnfollowedOpen(true)
        selectSession(session)
      } else {
        console.log('[usePrivateMessages] Session still not found after refresh')
      }
    }

    console.log('[usePrivateMessages] Setting up navigation listener')
    const cleanup = window.electronAPI.bilibili.onNavigateToSession(handleNavigateToSession)
    return () => {
      console.log('[usePrivateMessages] Cleaning up navigation listener')
      cleanup()
    }
  }, [selectSession, refreshSessionsQuietly, setActiveShop, findListedSession, refreshUnfollowedQuietly, isFolded])

  // Auto-connect WebSocket when logged in
  useEffect(() => {
    if (isConnected && !wsConnected && activeTransitionIdRef.current === null) {
      connectWebSocket()
    }
  }, [isConnected, wsConnected, connectWebSocket])

  // Update dock badge with total unread count (macOS)
  // DND sessions don't count, matching Bilibili's own unread reminder
  useEffect(() => {
    const totalUnread = displayedSessions
      .filter(session => session.is_dnd !== 1)
      .reduce((sum, session) => sum + (session.unread_count || 0), 0)
    window.electronAPI.setBadgeCount(totalUnread).catch(err => {
      console.error('[usePrivateMessages] Failed to update dock badge:', err)
    })
  }, [displayedSessions])

  return {
    // State
    sessions: displayedSessions,
    selectedSession: displayedSelectedSession,
    targetMessage,
    messages,
    emojiInfoMap,
    // An account's first load shows a skeleton however it started, a switch included
    loading: loading || listsPending,
    loadingMore,
    messagesLoading,
    sendingMessage,
    error,
    isConnected,
    initializing,
    userCache,
    hasMoreSessions,
    userInfo,
    wsConnected,

    // Multi-account state
    accounts,
    activeAccountMid,
    isAddingAccount,
    reauthAccount,

    // Customer service chats shown in 客服消息
    customerServiceSessions,
    activeCustomerService,
    selectCustomerService,
    sendCustomerServiceReply,

    // 收起未关注人消息 and 未关注人消息
    unfollowFold,
    unfollowed,
    toggleUnfollowFold,
    openUnfollowed,
    closeUnfollowed,
    loadMoreUnfollowed,
    searchHeldChats,

    // Actions
    checkLogin,
    logout,
    fetchSessions,
    loadMoreSessions,
    fetchMessages,
    selectSession,
    clearSelectedSession,
    sendMessage,
    sendImageMessage,
    recallMessage,
    toggleDnd,
    toggleSticky,
    connectWebSocket,
    disconnectWebSocket,

    // Multi-account actions
    fetchAccounts,
    switchAccount,
    removeAccount: removeAccountFn,
    reorderAccounts: reorderAccountsFn,
    startAddingAccount,
    cancelAddingAccount,
    onAccountAdded,
    startReauthAccount,
    cancelReauthAccount,
    onReauthSuccess,
  }
}
