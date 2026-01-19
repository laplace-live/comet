import type {
  BilibiliCredentials,
  BilibiliImageUploadResponse,
  BilibiliMessagesResponse,
  BilibiliSendMessageResponse,
  BilibiliSessionsResponse,
  BilibiliUserCardsResponse,
} from './bilibili'

export interface FetchSessionsParams {
  sessionType?: string
  size?: string
  endTs?: string
}

export interface FetchMessagesParams {
  talkerId: string
  sessionType?: string
  size?: string
  beginSeqno?: string
  endSeqno?: string
}

export interface FetchUsersParams {
  uids: string
}

export interface UpdateAckParams {
  talkerId: string
  sessionType: string
  ackSeqno: string
}

export interface UpdateAckResponse {
  code: number
  msg?: string
  message?: string
  ttl?: number
  data?: Record<string, unknown>
}

export interface SendMessageParams {
  receiverId: string
  receiverType: string
  msgType: string
  content: string
}

export interface UploadImageParams {
  /** Base64 encoded image data (without data:image/... prefix) */
  imageData: string
  /** Image MIME type (e.g., 'image/jpeg', 'image/png') */
  mimeType: string
}

export interface UploadImageResult {
  success: boolean
  url?: string
  width?: number
  height?: number
  error?: string
}

export interface SendMessageResponse {
  code: number
  message?: string
  ttl?: number
  data?: {
    // msg_key may be a string to preserve precision for large integers
    msg_key: number | string
    e_infos?: Array<{
      text: string
      url: string
      size: number
      gif_url?: string
    }>
    msg_content?: string
    key_hit_infos?: {
      toast?: string
      rule_id?: number
      high_text?: Array<Record<string, unknown>>
    }
  } | null
}

export interface QRPollParams {
  qrcodeKey: string
  // When true, don't auto-save the account (used during re-auth to validate first)
  skipSave?: boolean
}

export interface ErrorResponse {
  error: string
  code: number
}

export interface QRGenerateResult {
  code: number
  message?: string
  data?: {
    url: string
    qrcode_key: string
  }
  qrImageUrl?: string
  error?: string
}

export interface StoredAccountInfo {
  mid: number
  uname: string
  face?: string
  isExpired?: boolean
}

export interface QRPollResult {
  code: number
  message?: string
  data?: {
    url: string
    refresh_token: string
    timestamp: number
    code: number
    message: string
  }
  credentials?: BilibiliCredentials
  userInfo?: StoredAccountInfo
  error?: string
}

export interface GetAccountsResult {
  accounts: StoredAccountInfo[]
  activeAccountMid: number | null
}

export interface SetActiveAccountParams {
  mid: number
}

export interface SetActiveAccountResult {
  success: boolean
}

export interface RemoveAccountParams {
  mid: number
}

export interface RemoveAccountResult {
  success: boolean
  remainingAccounts: StoredAccountInfo[]
  activeAccountMid: number | null
}

export interface ReauthAccountParams {
  mid: number
  credentials: BilibiliCredentials
}

export interface ReauthAccountResult {
  success: boolean
  error?: string
  actualMid?: number
  userInfo?: StoredAccountInfo
}

export interface CheckLoginResult {
  isLogin: boolean
  mid?: number
  uname?: string
  face?: string
  expiredAccountMid?: number
}

export interface WSStatusResult {
  connected: boolean
  authenticated: boolean
}

export interface NewMessageNotification {
  talkerId: number
  sessionType: number
  msgType?: number
  latestSeqno?: number
  instantMsg?: {
    senderUid: number
    receiverType: number
    receiverId: number
    msgType: number
    content: string
    msgSeqno: number
    timestamp: number
    // msgKey is stored as string to preserve precision for large integers
    msgKey: string
  }
}

export interface SessionUpdateNotification {
  type: 'session_list' | 'total_unread' | 'quick_link' | 'fetch_message'
  sessionId?: {
    privateId?: { uid: number }
    groupId?: { groupId: number }
    systemId?: { systemMsgType: number }
  }
}

export interface ShowNotificationParams {
  title: string
  body: string
  icon?: string
  talkerId: number
  sessionType: number
}

export interface NavigateToSessionParams {
  talkerId: number
  sessionType: number
}

export interface CopyImageParams {
  imageUrl: string
}

export interface CopyImageResult {
  success: boolean
  error?: string
}

export interface ElectronAPI {
  // Platform detection for OS-specific UI adjustments (e.g., 'darwin', 'win32', 'linux')
  platform: NodeJS.Platform

  bilibili: {
    // QR Code Login
    qrGenerate: () => Promise<QRGenerateResult>
    qrPoll: (params: QRPollParams) => Promise<QRPollResult>
    getCredentials: () => Promise<BilibiliCredentials | null>
    logout: () => Promise<{ success: boolean }>
    checkLogin: () => Promise<CheckLoginResult>

    // Multi-account management
    getAccounts: () => Promise<GetAccountsResult>
    setActiveAccount: (params: SetActiveAccountParams) => Promise<SetActiveAccountResult>
    removeAccount: (params: RemoveAccountParams) => Promise<RemoveAccountResult>
    reauthAccount: (params: ReauthAccountParams) => Promise<ReauthAccountResult>

    // Data fetching
    fetchSessions: (params: FetchSessionsParams) => Promise<BilibiliSessionsResponse | ErrorResponse>
    fetchMessages: (params: FetchMessagesParams) => Promise<BilibiliMessagesResponse | ErrorResponse>
    fetchUsers: (params: FetchUsersParams) => Promise<BilibiliUserCardsResponse | ErrorResponse>

    // Actions
    updateAck: (params: UpdateAckParams) => Promise<UpdateAckResponse | ErrorResponse>
    sendMessage: (params: SendMessageParams) => Promise<BilibiliSendMessageResponse | ErrorResponse>
    uploadImage: (params: UploadImageParams) => Promise<UploadImageResult>

    // WebSocket for real-time notifications
    wsConnect: () => Promise<{ success: boolean }>
    wsDisconnect: () => Promise<{ success: boolean }>
    wsStatus: () => Promise<WSStatusResult>

    // Event listeners for real-time notifications (return cleanup function)
    onNewMessage: (callback: (notification: NewMessageNotification) => void) => () => void
    onSessionUpdate: (callback: (notification: SessionUpdateNotification) => void) => () => void
    onWsConnected: (callback: () => void) => () => void
    onWsDisconnected: (callback: () => void) => () => void

    // System notifications
    showNotification: (params: ShowNotificationParams) => Promise<{ shown: boolean; reason?: string }>
    onNavigateToSession: (callback: (params: NavigateToSessionParams) => void) => () => void
  }

  // Clipboard utilities
  clipboard: {
    copyImage: (params: CopyImageParams) => Promise<CopyImageResult>
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
