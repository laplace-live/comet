import { useCallback, useEffect, useRef, useState } from 'react'

import type { UserCache } from '@/lib/message-utils'
import type {
  BilibiliEmojiInfo,
  BilibiliMessage,
  BilibiliMessagesResponse,
  BilibiliSession,
  BilibiliSessionsResponse,
  BilibiliUserCardsResponse,
} from '@/types/bilibili'
import type {
  CheckLoginResult,
  ErrorResponse,
  NavigateToSessionParams,
  NewMessageNotification,
  SendMessageResponse,
  SessionUpdateNotification,
  StoredAccountInfo,
} from '@/types/electron'

import { SESSION_TYPE } from '@/types/bilibili'

import { getImageType } from '@/lib/const'
import { parseMessageContent } from '@/lib/message-utils'

import { toastManager } from '@/components/ui/toast'

// Helper to check if response is an error
function isErrorResponse(
  response:
    | BilibiliSessionsResponse
    | BilibiliMessagesResponse
    | BilibiliUserCardsResponse
    | SendMessageResponse
    | ErrorResponse
): response is ErrorResponse {
  return 'error' in response
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

  // Keep refs in sync with state
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    userCacheRef.current = userCache
  }, [userCache])

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
    async (message: BilibiliMessage, senderUid: number, talkerId: number, sessionType: number) => {
      // Don't notify for our own messages
      if (userInfo?.mid && senderUid === userInfo.mid) return

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
        await window.electronAPI.bilibili.showNotification({
          title: senderName,
          body: messageText || '[新消息]',
          icon: senderAvatar,
          talkerId,
          sessionType,
        })
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
  }, [fetchUserInfoBatch])

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

  const fetchMessages = useCallback(
    async (session: BilibiliSession) => {
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
        setMessages(allMessages.reverse())
        setMessagesLoading(false)

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
    [mergeEmojiInfos]
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

        const newMessages = data.data?.messages || []

        // Merge emoji infos from this response
        mergeEmojiInfos(data.data?.e_infos)

        if (newMessages.length === 0) return

        // Merge new messages with existing ones, avoiding duplicates
        setMessages(prev => {
          // Create a Set of existing message keys for fast lookup
          const existingKeys = new Set(prev.map(m => m.msg_key))
          const existingSeqnos = new Set(prev.map(m => m.msg_seqno))

          // Filter out messages that already exist
          const uniqueNewMessages = newMessages.filter(
            m => !existingKeys.has(m.msg_key) && !existingSeqnos.has(m.msg_seqno)
          )

          if (uniqueNewMessages.length === 0) return prev

          // Merge and sort by timestamp (oldest first)
          const merged = [...prev, ...uniqueNewMessages]
          merged.sort((a, b) => a.timestamp - b.timestamp)
          return merged
        })

        // Mark as read since we're viewing this session
        if (data.data?.max_seqno) {
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
    [mergeEmojiInfos]
  )

  const selectSession = useCallback(
    (session: BilibiliSession) => {
      setSelectedSession(session)
      setMessages([])
      fetchMessages(session)
    },
    [fetchMessages]
  )

  const clearSelectedSession = useCallback(() => {
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

        const data = await window.electronAPI.bilibili.sendMessage({
          receiverId: String(selectedSession.talker_id),
          receiverType: String(selectedSession.session_type),
          msgType: '1', // Text message
          content: msgContent,
        })

        if (isErrorResponse(data)) {
          console.error('Failed to send message:', data.error)
          return false
        }

        if (data.code !== 0) {
          console.error('Failed to send message:', data.message)
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
        return false
      } finally {
        setSendingMessage(false)
      }
    },
    [selectedSession, userInfo]
  )

  // Recall a message by sending a msg_type=5 message with the target msg_key
  // We use msgSeqno for local state update (reliable number) and msgKeyStr for the API (string to avoid precision loss)
  const recallMessage = useCallback(
    async (msgSeqno: number, msgKeyStr: string): Promise<{ success: boolean; error?: string }> => {
      const senderMid = userInfo?.mid
      if (!selectedSession || !senderMid) {
        return { success: false, error: '无法撤回消息' }
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

  // Send image message to the current session
  const sendImageMessage = useCallback(
    async (imageData: string, mimeType: string): Promise<boolean> => {
      const senderMid = userInfo?.mid
      if (!selectedSession || !senderMid || !imageData) {
        return false
      }

      setSendingMessage(true)

      try {
        // First, upload the image to Bilibili CDN
        const uploadResult = await window.electronAPI.bilibili.uploadImage({
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
    [selectedSession, userInfo]
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
    async (talkerId: number, sessionType: number) => {
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
          showNotificationForMessage(latestMsg, latestMsg.sender_uid, talkerId, sessionType)
        }
      } catch (err) {
        console.error('[usePrivateMessages] Failed to fetch message for notification:', err)
      }
    },
    [showNotificationForMessage]
  )

  // Handle new message notification - uses incremental update, no spinners
  const handleNewMessage = useCallback(
    (notification: NewMessageNotification) => {
      console.log('[usePrivateMessages] New message notification:', notification)

      const isCurrentSession =
        selectedSession?.talker_id === notification.talkerId &&
        selectedSession?.session_type === notification.sessionType

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

          // Also mark as read since we're viewing it
          if (selectedSession.max_seqno) {
            window.electronAPI.bilibili
              .updateAck({
                talkerId: String(selectedSession.talker_id),
                sessionType: String(selectedSession.session_type),
                ackSeqno: String(notification.latestSeqno || selectedSession.max_seqno),
              })
              .catch(err => console.error('Failed to mark as read:', err))
          }
        } else {
          // No instant message data available - do a silent fetch to get new messages
          fetchMessagesQuietly(selectedSession)
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
          showNotificationForMessage(tempMessage, instantMsg.senderUid, notification.talkerId, notification.sessionType)
        } else {
          // No instant message data - fetch the latest message for notification
          fetchLatestMessageForNotification(notification.talkerId, notification.sessionType)
        }
      }

      // Update session list to reflect new messages (incremental update, no refetch)
      setSessions(prev => {
        const existingSessionIndex = prev.findIndex(
          s => s.talker_id === notification.talkerId && s.session_type === notification.sessionType
        )

        if (existingSessionIndex >= 0) {
          const updatedSessions = [...prev]
          const session = { ...updatedSessions[existingSessionIndex] }

          // Update unread count only if not the currently selected session
          if (!isCurrentSession) {
            session.unread_count = (session.unread_count || 0) + 1
          } else {
            session.unread_count = 0
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

          // Move to top of list if it has new messages
          session.session_ts = Date.now() * 1000 // Update timestamp
          updatedSessions.splice(existingSessionIndex, 1)
          updatedSessions.unshift(session)

          return updatedSessions
        }

        // Session not found - this is a new conversation, do a silent background refresh
        // We'll fetch sessions without showing a spinner
        refreshSessionsQuietly()
        return prev
      })
    },
    [
      selectedSession,
      refreshSessionsQuietly,
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
        setSelectedSession(session)
        setMessages([])
        fetchMessages(session)
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
  }, [fetchMessages, refreshSessionsQuietly])

  // Auto-connect WebSocket when logged in
  useEffect(() => {
    if (isConnected && !wsConnected) {
      connectWebSocket()
    }
  }, [isConnected, wsConnected, connectWebSocket])

  // Update dock badge with total unread count (macOS)
  useEffect(() => {
    const totalUnread = sessions.reduce((sum, session) => sum + (session.unread_count || 0), 0)
    window.electronAPI.setBadgeCount(totalUnread).catch(err => {
      console.error('[usePrivateMessages] Failed to update dock badge:', err)
    })
  }, [sessions])

  return {
    // State
    sessions,
    selectedSession,
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
