// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron'

import type { BilibiliCredentials } from './types/bilibili'
import type {
  CheckLoginResult,
  CopyImageParams,
  CopyImageResult,
  FetchMessagesParams,
  FetchSessionsParams,
  FetchUsersParams,
  GetAccountsResult,
  NavigateToSessionParams,
  NewMessageNotification,
  QRGenerateResult,
  QRPollParams,
  QRPollResult,
  ReauthAccountParams,
  ReauthAccountResult,
  RemoveAccountParams,
  RemoveAccountResult,
  ReorderAccountsParams,
  ReorderAccountsResult,
  SendMessageParams,
  SessionUpdateNotification,
  SetActiveAccountParams,
  SetActiveAccountResult,
  ShowNotificationParams,
  UpdateAckParams,
  UploadImageParams,
  UploadImageResult,
  WSStatusResult,
} from './types/electron'

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Platform detection for OS-specific UI adjustments
  platform: process.platform,

  // App info
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),

  // Badge count (macOS dock badge / Windows taskbar overlay)
  setBadgeCount: (count: number): Promise<{ success: boolean; reason?: string }> =>
    ipcRenderer.invoke('app:set-badge-count', count),

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
    reorderAccounts: (params: ReorderAccountsParams): Promise<ReorderAccountsResult> =>
      ipcRenderer.invoke('bilibili:reorder-accounts', params),

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
