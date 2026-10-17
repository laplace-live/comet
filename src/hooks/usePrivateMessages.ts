import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { UserCache } from '@/lib/message-utils'
import type {
  BilibiliEmojiInfo,
  BilibiliMessage,
  BilibiliSession,
  CustomerServiceMessage,
  CustomerServiceSession,
} from '@/types/bilibili'
import type {
  CheckLoginResult,
  CustomerServiceShop,
  ErrorResponse,
  NavigateToSessionParams,
  NewMessageNotification,
  SessionUpdateNotification,
  StoredAccountInfo,
} from '@/types/electron'

import { CS_MSG_TYPE, CS_SENDER_TYPE, CUSTOMER_SERVICE_WS_SESSION_TYPES, SESSION_TYPE } from '@/types/bilibili'

import { getImageType } from '@/lib/const'
import { type CustomerServiceReply, getCustomerServiceShop, isSameShop, toDisplayMessage } from '@/lib/customer-service'
import {
  getLastMessagePreview,
  getSessionAvatar,
  getSessionName,
  isCustomerServiceSession,
  parseMessageContent,
} from '@/lib/message-utils'

import { toastManager } from '@/components/ui/toast'

import { useDrafts } from '@/stores/useDrafts'
import { useSettings } from '@/stores/useSettings'

// Helper to check if response is an error
function isErrorResponse<T extends object>(response: T | ErrorResponse): response is ErrorResponse {
  return 'error' in response
}

// Show the local 客服消息 mute as is_dnd, so it reads like any other muted session
function withLocalDnd(session: BilibiliSession): BilibiliSession {
  return isCustomerServiceSession(session) ? { ...session, is_dnd: 1 } : session
}

// Map of emoji text (e.g., "[tv_doge]") to emoji info
export type EmojiInfoMap = Record<string, BilibiliEmojiInfo>

export interface UsePrivateMessagesReturn {
  // State
  sessions: BilibiliSession[]
  selectedSession: BilibiliSession | null
  messages: BilibiliMessage[]
  emojiInfoMap: EmojiInfoMap
  loading: boolean
  loadingMore: boolean
  messagesLoading: boolean
  sendingMessage: boolean
  error: string | null
  isConnected: boolean
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

  // Actions
  checkLogin: () => Promise<boolean>
  logout: () => Promise<void>
  fetchSessions: () => Promise<void>
  loadMoreSessions: () => Promise<void>
  fetchMessages: (session: BilibiliSession) => Promise<void>
  selectSession: (session: BilibiliSession) => void
  clearSelectedSession: () => void
  sendMessage: (content: string) => Promise<boolean>
  sendImageMessage: (imageData: string, mimeType: string) => Promise<boolean>
  recallMessage: (msgSeqno: number, msgKeyStr: string) => Promise<{ success: boolean; error?: string }>
  toggleDnd: (session: BilibiliSession, enabled: boolean) => Promise<boolean>
  toggleSticky: (session: BilibiliSession, pinned: boolean) => Promise<boolean>
  connectWebSocket: () => Promise<void>
  disconnectWebSocket: () => Promise<void>

  // Multi-account actions
  fetchAccounts: () => Promise<void>
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
  const [messages, setMessages] = useState<BilibiliMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [sendingMessage, setSendingMessage] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [userCache, setUserCache] = useState<UserCache>({})
  const [hasMoreSessions, setHasMoreSessions] = useState(false)
  const [nextEndTs, setNextEndTs] = useState<number | null>(null)
  const [userInfo, setUserInfo] = useState<CheckLoginResult | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [emojiInfoMap, setEmojiInfoMap] = useState<EmojiInfoMap>({})

  // Multi-account state
  const [accounts, setAccounts] = useState<StoredAccountInfo[]>([])
  const [activeAccountMid, setActiveAccountMid] = useState<number | null>(null)
  const [isAddingAccount, setIsAddingAccount] = useState(false)
  const [reauthAccount, setReauthAccount] = useState<StoredAccountInfo | null>(null)

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

  const customerServiceSessionsRef = useRef<CustomerServiceSession[]>([])
  const activeCustomerServiceShopRef = useRef<CustomerServiceShop | null>(null)

  useEffect(() => {
    customerServiceSessionsRef.current = customerServiceSessions
  }, [customerServiceSessions])

  // Also set synchronously, so a reply for a chat the user just left can tell
  const setActiveShop = useCallback((shop: CustomerServiceShop | null) => {
    activeCustomerServiceShopRef.current = shop
    setActiveCustomerServiceShop(shop)
  }, [])

  // Customer service chats belong to an account: forget them when another one signs in
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the account changes
  useEffect(() => {
    customerServiceSessionsRef.current = []
    setCustomerServiceSessions([])
    setActiveShop(null)
  }, [userInfo?.mid, setActiveShop])

  // Whether a reply for this customer service chat is still wanted
  const isCustomerServiceOpen = useCallback((shop: CustomerServiceShop) => {
    const session = selectedSessionRef.current
    return !!session && isCustomerServiceSession(session) && isSameShop(activeCustomerServiceShopRef.current, shop)
  }, [])

  // Mark a customer service chat as read, and take it off 客服消息's unread, which counts every chat's
  const ackCustomerService = useCallback((shop: CustomerServiceShop) => {
    window.electronAPI.bilibili.customerService
      .updateAck(shop)
      .catch(err => console.error('Failed to mark customer service chat as read:', err))

    const othersUnread = customerServiceSessionsRef.current
      .filter(s => !isSameShop(getCustomerServiceShop(s), shop))
      .reduce((sum, s) => sum + (s.unread_info?.unread_count || 0), 0)
    setCustomerServiceSessions(prev =>
      prev.map(s =>
        isSameShop(getCustomerServiceShop(s), shop) ? { ...s, unread_info: { ...s.unread_info, unread_count: 0 } } : s
      )
    )
    setSessions(prev => prev.map(s => (isCustomerServiceSession(s) ? { ...s, unread_count: othersUnread } : s)))
  }, [])

  // Track window focus state and mark current session as read when regaining focus
  useEffect(() => {
    const handleFocus = () => {
      windowFocusedRef.current = true

      // When window regains focus, mark the current session as read
      const session = selectedSessionRef.current
      // 客服消息 is read one customer service chat at a time
      if (session && isCustomerServiceSession(session)) {
        if (activeCustomerServiceShopRef.current) ackCustomerService(activeCustomerServiceShopRef.current)
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
        setSessions(prev =>
          prev.map(s =>
            s.talker_id === session.talker_id && s.session_type === session.session_type ? { ...s, unread_count: 0 } : s
          )
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
  }, [ackCustomerService])

  // Fetch user info for multiple users in batch
  const fetchUserInfoBatch = useCallback(async (uids: number[]) => {
    if (uids.length === 0) return

    try {
      // Batch up to 50 users per request (API limit)
      const batchSize = 50
      for (let i = 0; i < uids.length; i += batchSize) {
        const batch = uids.slice(i, i + batchSize)
        const uidsParam = batch.join(',')

        const data = await window.electronAPI.bilibili.fetchUsers({
          uids: uidsParam,
        })

        if (!isErrorResponse(data) && data.code === 0 && data.data) {
          const newCache: UserCache = {}
          for (const user of data.data) {
            newCache[user.mid] = {
              name: user.name,
              face: user.face,
              official: user.official,
              vip: user.vip,
            }
          }
          setUserCache(prev => ({ ...prev, ...newCache }))
        }
      }
    } catch (err) {
      console.error('Failed to fetch user info batch:', err)
    }
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
      const session = sessionsRef.current.find(isTargetSession) ?? (await refreshedSessions).find(isTargetSession)
      if (session?.is_dnd === 1) {
        console.log('[usePrivateMessages] Notification suppressed for DND session:', talkerId)
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
    [userInfo]
  )

  // Check login status
  const checkLogin = useCallback(async (): Promise<boolean> => {
    try {
      const result = await window.electronAPI.bilibili.checkLogin()
      setUserInfo(result)

      // Refresh accounts after checkLogin since it may have removed expired accounts
      const accountsResult = await window.electronAPI.bilibili.getAccounts()
      setAccounts(accountsResult.accounts)
      setActiveAccountMid(accountsResult.activeAccountMid)

      if (result.isLogin) {
        setIsConnected(true)
        return true
      }

      setIsConnected(false)
      return false
    } catch (err) {
      console.error('Failed to check login:', err)
      setIsConnected(false)
      return false
    }
  }, [])

  // Logout
  const logout = useCallback(async () => {
    try {
      // Disconnect WebSocket first to stop receiving notifications for this user
      await window.electronAPI.bilibili.wsDisconnect()
      setWsConnected(false)

      await window.electronAPI.bilibili.logout()

      // Logout removes the active account, so forget its drafts too
      if (userInfo?.mid) {
        useDrafts.getState().clearAccountDrafts(userInfo.mid)
      }

      // Clear current session state
      setSessions([])
      setSelectedSession(null)
      setMessages([])
      setUserCache({})
      setHasMoreSessions(false)
      setNextEndTs(null)

      // Check login - this may remove additional expired accounts on the backend
      const loginResult = await window.electronAPI.bilibili.checkLogin()
      setUserInfo(loginResult)

      // Refresh accounts AFTER checkLogin since it may have removed expired accounts
      const accountsResult = await window.electronAPI.bilibili.getAccounts()
      setAccounts(accountsResult.accounts)
      setActiveAccountMid(accountsResult.activeAccountMid)

      if (loginResult.isLogin) {
        setIsConnected(true)
        // Fetch sessions for the new account
        const sessionsData = await window.electronAPI.bilibili.fetchSessions({})
        if (!isErrorResponse(sessionsData) && sessionsData.code === 0) {
          const sessionList = sessionsData.data?.session_list || []
          setSessions(sessionList)
          setHasMoreSessions(sessionsData.data?.has_more === 1)
          if (sessionList.length > 0) {
            setNextEndTs(sessionList[sessionList.length - 1].session_ts)
          }

          // Fetch user info for sessions that don't have account_info
          const uidsToFetch = sessionList
            .filter(session => session.session_type === SESSION_TYPE.USER && !session.account_info?.name)
            .map(session => session.talker_id)
          if (uidsToFetch.length > 0) {
            fetchUserInfoBatch(uidsToFetch)
          }
        }
        // Reconnect WebSocket for the new account
        await window.electronAPI.bilibili.wsConnect()
        return
      }

      // No remaining accounts or login failed - go to logged out state
      setIsConnected(false)
    } catch (err) {
      console.error('Failed to logout:', err)
    }
  }, [fetchUserInfoBatch, userInfo?.mid])

  const fetchSessions = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const data = await window.electronAPI.bilibili.fetchSessions({})

      if (isErrorResponse(data)) {
        throw new Error(data.error || 'Failed to fetch sessions')
      }

      if (data.code !== 0) {
        throw new Error(data.message || 'Failed to fetch sessions')
      }

      const sessionList = data.data?.session_list || []
      setSessions(sessionList)
      setIsConnected(true)
      setHasMoreSessions(data.data?.has_more === 1)

      // Store the session_ts of the last session for pagination
      if (sessionList.length > 0) {
        const lastSession = sessionList[sessionList.length - 1]
        setNextEndTs(lastSession.session_ts)
      } else {
        setNextEndTs(null)
      }

      // Find user sessions that don't have account_info and need fetching
      const uidsToFetch = sessionList
        .filter(session => session.session_type === SESSION_TYPE.USER && !session.account_info?.name)
        .map(session => session.talker_id)

      // Fetch user info for those sessions
      if (uidsToFetch.length > 0) {
        fetchUserInfoBatch(uidsToFetch)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch sessions')
      setIsConnected(false)
    } finally {
      setLoading(false)
    }
  }, [fetchUserInfoBatch])

  const loadMoreSessions = useCallback(async () => {
    if (!hasMoreSessions || nextEndTs === null || loadingMore) return

    setLoadingMore(true)

    try {
      const data = await window.electronAPI.bilibili.fetchSessions({
        endTs: String(nextEndTs),
      })

      if (isErrorResponse(data)) {
        throw new Error(data.error || 'Failed to fetch more sessions')
      }

      if (data.code !== 0) {
        throw new Error(data.message || 'Failed to fetch more sessions')
      }

      const sessionList = data.data?.session_list || []
      setSessions(prev => [...prev, ...sessionList])
      setHasMoreSessions(data.data?.has_more === 1)

      // Store the session_ts of the last session for pagination
      if (sessionList.length > 0) {
        const lastSession = sessionList[sessionList.length - 1]
        setNextEndTs(lastSession.session_ts)
      } else {
        setNextEndTs(null)
      }

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
    try {
      const data = await window.electronAPI.bilibili.customerService.fetchSessions()
      if (isErrorResponse(data) || data.code !== 0 || !data.data) {
        console.error('[usePrivateMessages] Failed to fetch customer service sessions:', data)
        return null
      }

      const list = data.data.session_list || []
      customerServiceSessionsRef.current = list
      setCustomerServiceSessions(list)
      return list
    } catch (err) {
      console.error('[usePrivateMessages] Failed to fetch customer service sessions:', err)
      return null
    }
  }, [])

  // Load a customer service chat, every page of it like fetchMessages does
  const fetchCustomerServiceMessages = useCallback(
    async (shop: CustomerServiceShop) => {
      setMessagesLoading(true)
      setEmojiInfoMap({})

      try {
        const loaded: CustomerServiceMessage[] = []
        let endSeqno: string | undefined
        let hasMore = true

        // Pages run newest first, each continuing from the oldest seqno of the last
        while (hasMore) {
          const data = await window.electronAPI.bilibili.customerService.fetchMessages({ ...shop, endSeqno })

          if (isErrorResponse(data)) {
            throw new Error(data.error || 'Failed to fetch customer service messages')
          }
          if (data.code !== 0 || !data.data) {
            throw new Error(data.message || 'Failed to fetch customer service messages')
          }

          loaded.push(...(data.data.messages || []))
          mergeEmojiInfos(data.data.e_infos)

          hasMore = data.data.has_more === 1 && !!data.data.min_seqno && data.data.min_seqno !== endSeqno
          endSeqno = data.data.min_seqno
        }

        if (!isCustomerServiceOpen(shop)) return
        setMessages(loaded.reverse().map(toDisplayMessage))
        ackCustomerService(shop)
      } catch (err) {
        console.error('Failed to fetch customer service messages:', err)
      } finally {
        if (isCustomerServiceOpen(shop)) setMessagesLoading(false)
      }
    },
    [mergeEmojiInfos, isCustomerServiceOpen, ackCustomerService]
  )

  // Add the open customer service chat's newest messages, without a spinner
  const fetchCustomerServiceMessagesQuietly = useCallback(
    async (shop: CustomerServiceShop) => {
      try {
        const data = await window.electronAPI.bilibili.customerService.fetchMessages(shop)
        if (isErrorResponse(data) || data.code !== 0 || !data.data) {
          console.error('[usePrivateMessages] Silent customer service fetch failed')
          return
        }
        if (!isCustomerServiceOpen(shop)) return

        mergeEmojiInfos(data.data.e_infos)

        // The newest page repeats what's shown, including messages sent from here, so match on msg_key
        const newest = (data.data.messages || []).map(toDisplayMessage).reverse()
        setMessages(prev => {
          const shown = new Set(prev.map(m => String(m.msg_key)))
          const added = newest.filter(m => !shown.has(String(m.msg_key)))
          return added.length > 0 ? [...prev, ...added] : prev
        })

        // Only mark as read if the window is focused (user is actively viewing)
        if (windowFocusedRef.current) ackCustomerService(shop)
      } catch (err) {
        console.error('[usePrivateMessages] Silent customer service fetch error:', err)
      }
    },
    [mergeEmojiInfos, isCustomerServiceOpen, ackCustomerService]
  )

  // Open 客服消息 on one of its chats: the one picked before if it's still listed, else the newest
  const openCustomerService = useCallback(async () => {
    setMessagesLoading(true)

    const picked = activeCustomerServiceShopRef.current
    const list = await fetchCustomerServiceSessions()
    // The user may have moved on while the list loaded, and that session's loading is its own
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

  // Send to the open customer service chat, showing the message right away
  const sendCustomerServiceMessage = useCallback(
    async (msgType: number, content: string): Promise<boolean> => {
      const shop = activeCustomerServiceShopRef.current
      const senderMid = userInfo?.mid
      if (!shop || !senderMid) return false

      const data = await window.electronAPI.bilibili.customerService.sendMessage({ ...shop, msgType, content })

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

      setMessages(prev => [...prev, sentMessage])
      setSessions(prev =>
        prev.map(s =>
          isCustomerServiceSession(s) ? { ...s, session_ts: Date.now() * 1000, last_msg: sentMessage } : s
        )
      )

      return true
    },
    [userInfo]
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

      try {
        const allMessages: BilibiliMessage[] = []
        let hasMore = true
        let endSeqno: string | undefined

        // Auto-load all pages
        while (hasMore) {
          const data = await window.electronAPI.bilibili.fetchMessages({
            talkerId: String(session.talker_id),
            sessionType: String(session.session_type),
            size: '1000', // Use larger page size to reduce number of requests
            endSeqno,
          })

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
        setMessages(sortedMessages)
        setMessagesLoading(false)

        // For group chats (fan groups), fetch user info for message senders
        if (session.session_type === SESSION_TYPE.FAN_GROUP) {
          // Collect unique sender UIDs (excluding 0 which is system messages)
          const senderUids = new Set<number>()
          for (const msg of sortedMessages) {
            if (msg.sender_uid && msg.sender_uid !== 0) {
              senderUids.add(msg.sender_uid)
            }
          }

          // Filter out UIDs already in cache or the current user
          const uidsToFetch = [...senderUids].filter(uid => uid !== userInfo?.mid && !userCacheRef.current[uid])

          if (uidsToFetch.length > 0) {
            fetchUserInfoBatch(uidsToFetch)
          }
        }

        // Mark session as read in the background (doesn't block message display)
        if (session.max_seqno) {
          try {
            await window.electronAPI.bilibili.updateAck({
              talkerId: String(session.talker_id),
              sessionType: String(session.session_type),
              ackSeqno: String(session.max_seqno),
            })

            // Update local session state to reflect read status
            setSessions(prev => prev.map(s => (s.talker_id === session.talker_id ? { ...s, unread_count: 0 } : s)))
          } catch (ackErr) {
            console.error('Failed to mark session as read:', ackErr)
          }
        }
      } catch (err) {
        console.error('Failed to fetch messages:', err)
        setMessagesLoading(false)
      }
    },
    [openCustomerService, mergeEmojiInfos, userInfo, fetchUserInfoBatch]
  )

  // Silent fetch of new messages - no loading spinner, merges with existing messages
  const fetchMessagesQuietly = useCallback(
    async (session: BilibiliSession) => {
      try {
        // Only fetch the first page (newest messages)
        const data = await window.electronAPI.bilibili.fetchMessages({
          talkerId: String(session.talker_id),
          sessionType: String(session.session_type),
          size: '1000',
        })

        if (isErrorResponse(data) || data.code !== 0) {
          console.error('[usePrivateMessages] Silent message fetch failed')
          return
        }

        // Guard: only update if still viewing this session (prevents stale responses)
        if (
          selectedSessionRef.current?.talker_id !== session.talker_id ||
          selectedSessionRef.current?.session_type !== session.session_type
        ) {
          return
        }

        const newMessages = data.data?.messages || []

        // Merge emoji infos from this response
        mergeEmojiInfos(data.data?.e_infos)

        if (newMessages.length === 0) return

        // Merge new messages with existing ones, avoiding duplicates
        let uniqueNewMessages: BilibiliMessage[] = []
        setMessages(prev => {
          // Create a Set of existing message keys for fast lookup
          const existingKeys = new Set(prev.map(m => m.msg_key))
          const existingSeqnos = new Set(prev.map(m => m.msg_seqno))

          // Filter out messages that already exist
          uniqueNewMessages = newMessages.filter(m => !existingKeys.has(m.msg_key) && !existingSeqnos.has(m.msg_seqno))

          if (uniqueNewMessages.length === 0) return prev

          // Merge and sort by timestamp (oldest first)
          const merged = [...prev, ...uniqueNewMessages]
          merged.sort((a, b) => a.timestamp - b.timestamp)
          return merged
        })

        // For group chats, fetch user info for new message senders
        if (session.session_type === SESSION_TYPE.FAN_GROUP && uniqueNewMessages.length > 0) {
          const senderUids = new Set<number>()
          for (const msg of uniqueNewMessages) {
            if (msg.sender_uid && msg.sender_uid !== 0) {
              senderUids.add(msg.sender_uid)
            }
          }
          const uidsToFetch = [...senderUids].filter(uid => uid !== userInfo?.mid && !userCacheRef.current[uid])
          if (uidsToFetch.length > 0) {
            fetchUserInfoBatch(uidsToFetch)
          }
        }

        // Only mark as read if the window is focused (user is actively viewing)
        if (data.data?.max_seqno && windowFocusedRef.current) {
          window.electronAPI.bilibili
            .updateAck({
              talkerId: String(session.talker_id),
              sessionType: String(session.session_type),
              ackSeqno: String(data.data.max_seqno),
            })
            .catch(err => console.error('Failed to mark as read:', err))

          // Update session unread count
          setSessions(prev => prev.map(s => (s.talker_id === session.talker_id ? { ...s, unread_count: 0 } : s)))
        }
      } catch (err) {
        console.error('[usePrivateMessages] Silent message fetch error:', err)
      }
    },
    [mergeEmojiInfos, userInfo, fetchUserInfoBatch]
  )

  const selectSession = useCallback(
    (session: BilibiliSession) => {
      // Ahead of the render, so replies for the session left behind can tell they're stale
      selectedSessionRef.current = session
      setSelectedSession(session)
      setMessages([])
      fetchMessages(session)
    },
    [fetchMessages]
  )

  const clearSelectedSession = useCallback(() => {
    selectedSessionRef.current = null
    setSelectedSession(null)
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

        // Add the new message to the messages list
        setMessages(prev => [...prev, newMessage])

        // Update the session's last_msg and session_ts
        setSessions(prev =>
          prev.map(s => {
            if (s.talker_id === selectedSession.talker_id) {
              return {
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
              }
            }
            return s
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
    [selectedSession, userInfo, sendCustomerServiceMessage]
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
        setSessions(prev =>
          prev.map(s => {
            if (s.talker_id === session.talker_id && s.session_type === session.session_type) {
              return { ...s, is_dnd: enabled ? 1 : 0 }
            }
            return s
          })
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
    [userInfo?.mid]
  )

  // Toggle sticky (pin/unpin) for a session
  const toggleSticky = useCallback(async (session: BilibiliSession, pinned: boolean): Promise<boolean> => {
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
      setSessions(prev =>
        prev.map(s => {
          if (s.talker_id === session.talker_id && s.session_type === session.session_type) {
            return { ...s, top_ts: pinned ? Date.now() * 1000 : 0 }
          }
          return s
        })
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
  }, [])

  // Send image message to the current session
  const sendImageMessage = useCallback(
    async (imageData: string, mimeType: string): Promise<boolean> => {
      const senderMid = userInfo?.mid
      if (!selectedSession || !senderMid || !imageData) {
        return false
      }

      setSendingMessage(true)

      try {
        // First, upload the image to Bilibili CDN (customer service takes uploads of its own)
        const isCustomerService = isCustomerServiceSession(selectedSession)
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
          return await sendCustomerServiceMessage(CS_MSG_TYPE.IMAGE, msgContent)
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

        // Add the new message to the messages list
        setMessages(prev => [...prev, newMessage])

        // Update the session's last_msg and session_ts
        setSessions(prev =>
          prev.map(s => {
            if (s.talker_id === selectedSession.talker_id) {
              return {
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
              }
            }
            return s
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
    [selectedSession, userInfo, sendCustomerServiceMessage]
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

  // Fetch all stored accounts
  const fetchAccounts = useCallback(async () => {
    try {
      const result = await window.electronAPI.bilibili.getAccounts()
      setAccounts(result.accounts)
      setActiveAccountMid(result.activeAccountMid)
    } catch (err) {
      console.error('[usePrivateMessages] Failed to fetch accounts:', err)
    }
  }, [])

  // Switch to a different account
  const switchAccount = useCallback(
    async (mid: number) => {
      try {
        // Disconnect current WebSocket first
        await window.electronAPI.bilibili.wsDisconnect()
        setWsConnected(false)

        // Switch the active account
        const result = await window.electronAPI.bilibili.setActiveAccount({ mid })
        if (!result.success) {
          console.error('[usePrivateMessages] Failed to switch account')
          return
        }

        // Clear current state
        setSessions([])
        setSelectedSession(null)
        setMessages([])
        setUserCache({})
        setHasMoreSessions(false)
        setNextEndTs(null)

        // Re-check login with new account - this may remove expired accounts
        const loginResult = await window.electronAPI.bilibili.checkLogin()
        setUserInfo(loginResult)

        // Refresh accounts AFTER checkLogin since it may have removed expired accounts
        // This ensures frontend state matches backend state
        const accountsResult = await window.electronAPI.bilibili.getAccounts()
        setAccounts(accountsResult.accounts)
        setActiveAccountMid(accountsResult.activeAccountMid)

        if (loginResult.isLogin) {
          setIsConnected(true)
          // Fetch sessions for the new account
          const sessionsData = await window.electronAPI.bilibili.fetchSessions({})
          if (!isErrorResponse(sessionsData) && sessionsData.code === 0) {
            const sessionList = sessionsData.data?.session_list || []
            setSessions(sessionList)
            setHasMoreSessions(sessionsData.data?.has_more === 1)
            if (sessionList.length > 0) {
              setNextEndTs(sessionList[sessionList.length - 1].session_ts)
            }

            // Fetch user info for sessions that don't have account_info
            const uidsToFetch = sessionList
              .filter(session => session.session_type === SESSION_TYPE.USER && !session.account_info?.name)
              .map(session => session.talker_id)
            if (uidsToFetch.length > 0) {
              fetchUserInfoBatch(uidsToFetch)
            }
          }
          // Reconnect WebSocket
          await window.electronAPI.bilibili.wsConnect()
        } else {
          setIsConnected(false)
        }
      } catch (err) {
        console.error('[usePrivateMessages] Failed to switch account:', err)
      }
    },
    [fetchUserInfoBatch]
  )

  // Remove an account
  const removeAccountFn = useCallback(
    async (mid: number) => {
      const wasActiveAccount = mid === activeAccountMid

      try {
        // If removing the active account, disconnect WS first
        if (wasActiveAccount) {
          await window.electronAPI.bilibili.wsDisconnect()
          setWsConnected(false)
        }

        const result = await window.electronAPI.bilibili.removeAccount({ mid })
        if (result.success) {
          useDrafts.getState().clearAccountDrafts(mid)
          setAccounts(result.remainingAccounts)
          setActiveAccountMid(result.activeAccountMid)

          // If we removed the active account, we need to reload state
          if (wasActiveAccount) {
            if (result.activeAccountMid) {
              // There's another account, switch to it
              await switchAccount(result.activeAccountMid)
            } else {
              // No more accounts, reset to logged out state
              setIsConnected(false)
              setUserInfo(null)
              setSessions([])
              setSelectedSession(null)
              setMessages([])
              setUserCache({})
            }
          }
        } else {
          // Removal failed - reconnect WebSocket if we disconnected it
          if (wasActiveAccount) {
            await window.electronAPI.bilibili.wsConnect()
          }
        }
      } catch (err) {
        console.error('[usePrivateMessages] Failed to remove account:', err)
        // Reconnect WebSocket if we disconnected it before the error
        if (wasActiveAccount) {
          try {
            await window.electronAPI.bilibili.wsConnect()
          } catch (wsErr) {
            console.error('[usePrivateMessages] Failed to reconnect WebSocket:', wsErr)
          }
        }
      }
    },
    [activeAccountMid, switchAccount]
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
    try {
      const data = await window.electronAPI.bilibili.fetchSessions({})

      if (isErrorResponse(data) || data.code !== 0) {
        console.error('[usePrivateMessages] Silent session refresh failed')
        return []
      }

      const sessionList = data.data?.session_list || []
      setSessions(sessionList)
      setHasMoreSessions(data.data?.has_more === 1)

      if (sessionList.length > 0) {
        const lastSession = sessionList[sessionList.length - 1]
        setNextEndTs(lastSession.session_ts)
      }

      // Fetch user info for new sessions
      const uidsToFetch = sessionList
        .filter(session => session.session_type === SESSION_TYPE.USER && !session.account_info?.name)
        .map(session => session.talker_id)

      if (uidsToFetch.length > 0) {
        fetchUserInfoBatch(uidsToFetch)
      }

      return sessionList
    } catch (err) {
      console.error('[usePrivateMessages] Silent session refresh error:', err)
      return []
    }
  }, [fetchUserInfoBatch])

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

  // session_ts of the 客服消息 state last notified about
  const notifiedCustomerServiceTsRef = useRef<number | null>(null)

  // Customer service notifications also arrive for the user's own messages, with no sender Comet can check.
  // Only a message to the user raises 客服消息's unread count, so that decides whether to notify.
  const showCustomerServiceNotification = useCallback(
    async (refreshedSessions: Promise<BilibiliSession[]>) => {
      const unreadBefore = sessionsRef.current.find(isCustomerServiceSession)?.unread_count ?? 0
      const session = (await refreshedSessions).find(isCustomerServiceSession)
      if (!session || session.unread_count <= unreadBefore) return

      // An earlier notification's refresh can already see the reply this one is for
      if (session.session_ts === notifiedCustomerServiceTsRef.current) return
      notifiedCustomerServiceTsRef.current = session.session_ts

      if (session.is_dnd === 1 || customerServiceMuted) {
        console.log('[usePrivateMessages] Notification suppressed for muted customer service session')
        return
      }

      try {
        const result = await window.electronAPI.bilibili.showNotification({
          title: getSessionName(session),
          body: getLastMessagePreview(session) || '[新消息]',
          icon: getSessionAvatar(session) ?? undefined,
          talkerId: session.talker_id,
          sessionType: session.session_type,
        })
        console.log('[usePrivateMessages] Notification result:', result)
      } catch (err) {
        console.error('[usePrivateMessages] Failed to show notification:', err)
      }
    },
    [customerServiceMuted]
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
        showCustomerServiceNotification(refreshedSessions)

        // With 客服消息 open, refresh its chats' unread counts and the chat on screen
        if (selectedSession && isCustomerServiceSession(selectedSession)) {
          fetchCustomerServiceSessions()
          if (activeCustomerServiceShopRef.current) {
            fetchCustomerServiceMessagesQuietly(activeCustomerServiceShopRef.current)
          }
        }
        return
      }

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

          // Append the new message only if it doesn't already exist (avoid duplicates)
          setMessages(prev => {
            const exists = prev.some(m => m.msg_key === newMessage.msg_key || m.msg_seqno === newMessage.msg_seqno)
            if (exists) return prev
            return [...prev, newMessage]
          })

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
            refreshedSessions
          )
        } else {
          // No instant message data available - do a silent fetch to get new messages
          fetchMessagesQuietly(selectedSession)

          // When window is not focused, also show a notification (fetch the latest message for it)
          if (!isWindowFocused) {
            fetchLatestMessageForNotification(notification.talkerId, notification.sessionType, refreshedSessions)
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
            refreshedSessions
          )
        } else {
          // No instant message data - fetch the latest message for notification
          fetchLatestMessageForNotification(notification.talkerId, notification.sessionType, refreshedSessions)
        }
      }

      // Update session list to reflect new messages (optimistic in-place update)
      setSessions(prev => {
        const existingSessionIndex = prev.findIndex(
          s => s.talker_id === notification.talkerId && s.session_type === notification.sessionType
        )

        if (existingSessionIndex >= 0) {
          const updatedSessions = [...prev]
          const session = { ...updatedSessions[existingSessionIndex] }

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
          updatedSessions[existingSessionIndex] = session

          return updatedSessions
        }

        return prev
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
      fetchMessagesQuietly,
      showNotificationForMessage,
      fetchLatestMessageForNotification,
    ]
  )

  // Handle session update notification - uses silent refresh, no spinners
  const handleSessionUpdate = useCallback(
    (notification: SessionUpdateNotification) => {
      console.log('[usePrivateMessages] Session update notification:', notification)

      switch (notification.type) {
        case 'session_list':
        case 'total_unread':
          // Silent background refresh - no spinner
          refreshSessionsQuietly()
          break
        case 'fetch_message':
          // For fetch_message, we don't need to do a full refetch since
          // handleNewMessage already appends the message directly.
          // This is just a hint that there are new messages, which we've already handled.
          break
      }
    },
    [refreshSessionsQuietly]
  )

  // Check login status and fetch accounts on mount
  useEffect(() => {
    const init = async () => {
      await fetchAccounts()
      await checkLogin()
    }
    init()
  }, [checkLogin, fetchAccounts])

  // Set up WebSocket event listeners
  useEffect(() => {
    // Set up event listeners
    const cleanupNewMessage = window.electronAPI.bilibili.onNewMessage(handleNewMessage)
    const cleanupSessionUpdate = window.electronAPI.bilibili.onSessionUpdate(handleSessionUpdate)
    const cleanupWsConnected = window.electronAPI.bilibili.onWsConnected(() => {
      console.log('[usePrivateMessages] WebSocket connected')
      setWsConnected(true)
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
  }, [handleNewMessage, handleSessionUpdate])

  // Handle navigation from notification clicks
  useEffect(() => {
    const handleNavigateToSession = async (params: NavigateToSessionParams) => {
      console.log('[usePrivateMessages] Navigate to session received:', params)
      console.log('[usePrivateMessages] Current sessions count:', sessionsRef.current.length)

      // Find the session in the current list
      let session = sessionsRef.current.find(
        s => s.talker_id === params.talkerId && s.session_type === params.sessionType
      )

      console.log('[usePrivateMessages] Found session in ref:', session ? 'yes' : 'no')

      if (!session) {
        // Session not in list yet - refresh sessions first
        console.log('[usePrivateMessages] Session not found, refreshing sessions first...')
        const refreshedSessions = await refreshSessionsQuietly()

        // Use the returned sessions directly (avoids race condition with ref sync)
        session = refreshedSessions.find(s => s.talker_id === params.talkerId && s.session_type === params.sessionType)
        console.log('[usePrivateMessages] After refresh, found session:', session ? 'yes' : 'no')
      }

      if (session) {
        // Select the session (this will fetch messages and mark as read)
        console.log('[usePrivateMessages] Selecting session:', session.talker_id)
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
  }, [selectSession, refreshSessionsQuietly])

  // Auto-connect WebSocket when logged in
  useEffect(() => {
    if (isConnected && !wsConnected) {
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
    messages,
    emojiInfoMap,
    loading,
    loadingMore,
    messagesLoading,
    sendingMessage,
    error,
    isConnected,
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
