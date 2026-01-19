// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron'

import type { BilibiliCredentials } from './types/bilibili'

// Bilibili API types for the bridge
export interface FetchSessionsParams {
  sessionType?: string
  size?: string
  endTs?: string
}

export interface FetchMessagesParams {
  talkerId: string
  sessionType?: string
  size?: string
}

export interface FetchUsersParams {
  uids: string
}

export interface UpdateAckParams {
  talkerId: string
  sessionType: string
  ackSeqno: string
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

export interface QRPollParams {
  qrcodeKey: string
  // When true, don't auto-save the account (used during re-auth to validate first)
  skipSave?: boolean
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
    msgKey: number
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

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Platform detection for OS-specific UI adjustments
  platform: process.platform,

  // App info
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),

  bilibili: {
    // QR Code Login
    qrGenerate: (): Promise<QRGenerateResult> => ipcRenderer.invoke('bilibili:qr-generate'),
    qrPoll: (params: QRPollParams): Promise<QRPollResult> => ipcRenderer.invoke('bilibili:qr-poll', params),
    getCredentials: (): Promise<BilibiliCredentials | null> => ipcRenderer.invoke('bilibili:get-credentials'),
    logout: (): Promise<{ success: boolean }> => ipcRenderer.invoke('bilibili:logout'),
    checkLogin: (): Promise<CheckLoginResult> => ipcRenderer.invoke('bilibili:check-login'),

    // Multi-account management
    getAccounts: (): Promise<GetAccountsResult> => ipcRenderer.invoke('bilibili:get-accounts'),
    setActiveAccount: (params: SetActiveAccountParams): Promise<SetActiveAccountResult> =>
      ipcRenderer.invoke('bilibili:set-active-account', params),
    removeAccount: (params: RemoveAccountParams): Promise<RemoveAccountResult> =>
      ipcRenderer.invoke('bilibili:remove-account', params),
    reauthAccount: (params: ReauthAccountParams): Promise<ReauthAccountResult> =>
      ipcRenderer.invoke('bilibili:reauth-account', params),

    // Data fetching
    fetchSessions: (params: FetchSessionsParams) => ipcRenderer.invoke('bilibili:fetch-sessions', params),
    fetchMessages: (params: FetchMessagesParams) => ipcRenderer.invoke('bilibili:fetch-messages', params),
    fetchUsers: (params: FetchUsersParams) => ipcRenderer.invoke('bilibili:fetch-users', params),

    // Actions
    updateAck: (params: UpdateAckParams) => ipcRenderer.invoke('bilibili:update-ack', params),
    sendMessage: (params: SendMessageParams) => ipcRenderer.invoke('bilibili:send-message', params),
    uploadImage: (params: UploadImageParams): Promise<UploadImageResult> =>
      ipcRenderer.invoke('bilibili:upload-image', params),

    // WebSocket for real-time notifications
    wsConnect: (): Promise<{ success: boolean }> => ipcRenderer.invoke('bilibili:ws-connect'),
    wsDisconnect: (): Promise<{ success: boolean }> => ipcRenderer.invoke('bilibili:ws-disconnect'),
    wsStatus: (): Promise<WSStatusResult> => ipcRenderer.invoke('bilibili:ws-status'),

    // Event listeners for real-time notifications
    onNewMessage: (callback: (notification: NewMessageNotification) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, notification: NewMessageNotification) => {
        callback(notification)
      }
      ipcRenderer.on('bilibili:new-message', listener)
      // Return cleanup function
      return () => {
        ipcRenderer.removeListener('bilibili:new-message', listener)
      }
    },
    onSessionUpdate: (callback: (notification: SessionUpdateNotification) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, notification: SessionUpdateNotification) => {
        callback(notification)
      }
      ipcRenderer.on('bilibili:session-update', listener)
      return () => {
        ipcRenderer.removeListener('bilibili:session-update', listener)
      }
    },
    onWsConnected: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('bilibili:ws-connected', listener)
      return () => {
        ipcRenderer.removeListener('bilibili:ws-connected', listener)
      }
    },
    onWsDisconnected: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('bilibili:ws-disconnected', listener)
      return () => {
        ipcRenderer.removeListener('bilibili:ws-disconnected', listener)
      }
    },

    // System notifications
    showNotification: (params: ShowNotificationParams): Promise<{ shown: boolean; reason?: string }> =>
      ipcRenderer.invoke('show-notification', params),

    // Navigation event listener (for notification clicks)
    onNavigateToSession: (callback: (params: NavigateToSessionParams) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, params: NavigateToSessionParams) => {
        console.log('[Preload] Navigate to session event received:', params)
        callback(params)
      }
      ipcRenderer.on('bilibili:navigate-to-session', listener)
      console.log('[Preload] Navigation listener registered')
      return () => {
        ipcRenderer.removeListener('bilibili:navigate-to-session', listener)
      }
    },
  },

  // Clipboard utilities
  clipboard: {
    copyImage: (params: CopyImageParams): Promise<CopyImageResult> =>
      ipcRenderer.invoke('clipboard:copy-image', params),
  },

  // App menu event listeners
  onOpenAbout: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('app:open-about', listener)
    return () => {
      ipcRenderer.removeListener('app:open-about', listener)
    }
  },
  onOpenSettings: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('app:open-settings', listener)
    return () => {
      ipcRenderer.removeListener('app:open-settings', listener)
    }
  },
})
