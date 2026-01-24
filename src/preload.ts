// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron'

import type { BilibiliCredentials } from './types/bilibili'
import type {
  CheckForUpdatesResult,
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
  SetDndParams,
  SetDndResult,
  ShowNotificationParams,
  UpdateAckParams,
  UpdateStatusInfo,
  UploadImageParams,
  UploadImageResult,
  WSStatusResult,
} from './types/electron'

import { IpcChannel, IpcEvent } from './lib/ipc'

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Platform detection for OS-specific UI adjustments
  platform: process.platform,

  // App info
  getVersion: (): Promise<string> => ipcRenderer.invoke(IpcChannel.APP_GET_VERSION),

  // Badge count (macOS dock badge / Windows taskbar overlay)
  setBadgeCount: (count: number): Promise<{ success: boolean; reason?: string }> =>
    ipcRenderer.invoke(IpcChannel.APP_SET_BADGE_COUNT, count),

  bilibili: {
    // QR Code Login
    qrGenerate: (): Promise<QRGenerateResult> => ipcRenderer.invoke(IpcChannel.BILIBILI_QR_GENERATE),
    qrPoll: (params: QRPollParams): Promise<QRPollResult> => ipcRenderer.invoke(IpcChannel.BILIBILI_QR_POLL, params),
    getCredentials: (): Promise<BilibiliCredentials | null> => ipcRenderer.invoke(IpcChannel.BILIBILI_GET_CREDENTIALS),
    logout: (): Promise<{ success: boolean }> => ipcRenderer.invoke(IpcChannel.BILIBILI_LOGOUT),
    checkLogin: (): Promise<CheckLoginResult> => ipcRenderer.invoke(IpcChannel.BILIBILI_CHECK_LOGIN),

    // Multi-account management
    getAccounts: (): Promise<GetAccountsResult> => ipcRenderer.invoke(IpcChannel.BILIBILI_GET_ACCOUNTS),
    setActiveAccount: (params: SetActiveAccountParams): Promise<SetActiveAccountResult> =>
      ipcRenderer.invoke(IpcChannel.BILIBILI_SET_ACTIVE_ACCOUNT, params),
    removeAccount: (params: RemoveAccountParams): Promise<RemoveAccountResult> =>
      ipcRenderer.invoke(IpcChannel.BILIBILI_REMOVE_ACCOUNT, params),
    reauthAccount: (params: ReauthAccountParams): Promise<ReauthAccountResult> =>
      ipcRenderer.invoke(IpcChannel.BILIBILI_REAUTH_ACCOUNT, params),
    reorderAccounts: (params: ReorderAccountsParams): Promise<ReorderAccountsResult> =>
      ipcRenderer.invoke(IpcChannel.BILIBILI_REORDER_ACCOUNTS, params),

    // Data fetching
    fetchSessions: (params: FetchSessionsParams) => ipcRenderer.invoke(IpcChannel.BILIBILI_FETCH_SESSIONS, params),
    fetchMessages: (params: FetchMessagesParams) => ipcRenderer.invoke(IpcChannel.BILIBILI_FETCH_MESSAGES, params),
    fetchUsers: (params: FetchUsersParams) => ipcRenderer.invoke(IpcChannel.BILIBILI_FETCH_USERS, params),

    // Actions
    updateAck: (params: UpdateAckParams) => ipcRenderer.invoke(IpcChannel.BILIBILI_UPDATE_ACK, params),
    sendMessage: (params: SendMessageParams) => ipcRenderer.invoke(IpcChannel.BILIBILI_SEND_MESSAGE, params),
    uploadImage: (params: UploadImageParams): Promise<UploadImageResult> =>
      ipcRenderer.invoke(IpcChannel.BILIBILI_UPLOAD_IMAGE, params),
    setDnd: (params: SetDndParams): Promise<SetDndResult> => ipcRenderer.invoke(IpcChannel.BILIBILI_SET_DND, params),

    // WebSocket for real-time notifications
    wsConnect: (): Promise<{ success: boolean }> => ipcRenderer.invoke(IpcChannel.BILIBILI_WS_CONNECT),
    wsDisconnect: (): Promise<{ success: boolean }> => ipcRenderer.invoke(IpcChannel.BILIBILI_WS_DISCONNECT),
    wsStatus: (): Promise<WSStatusResult> => ipcRenderer.invoke(IpcChannel.BILIBILI_WS_STATUS),

    // Event listeners for real-time notifications
    onNewMessage: (callback: (notification: NewMessageNotification) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, notification: NewMessageNotification) => {
        callback(notification)
      }
      ipcRenderer.on(IpcEvent.BILIBILI_NEW_MESSAGE, listener)
      // Return cleanup function
      return () => {
        ipcRenderer.removeListener(IpcEvent.BILIBILI_NEW_MESSAGE, listener)
      }
    },
    onSessionUpdate: (callback: (notification: SessionUpdateNotification) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, notification: SessionUpdateNotification) => {
        callback(notification)
      }
      ipcRenderer.on(IpcEvent.BILIBILI_SESSION_UPDATE, listener)
      return () => {
        ipcRenderer.removeListener(IpcEvent.BILIBILI_SESSION_UPDATE, listener)
      }
    },
    onWsConnected: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on(IpcEvent.BILIBILI_WS_CONNECTED, listener)
      return () => {
        ipcRenderer.removeListener(IpcEvent.BILIBILI_WS_CONNECTED, listener)
      }
    },
    onWsDisconnected: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on(IpcEvent.BILIBILI_WS_DISCONNECTED, listener)
      return () => {
        ipcRenderer.removeListener(IpcEvent.BILIBILI_WS_DISCONNECTED, listener)
      }
    },

    // System notifications
    showNotification: (params: ShowNotificationParams): Promise<{ shown: boolean; reason?: string }> =>
      ipcRenderer.invoke(IpcChannel.SHOW_NOTIFICATION, params),

    // Navigation event listener (for notification clicks)
    onNavigateToSession: (callback: (params: NavigateToSessionParams) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, params: NavigateToSessionParams) => {
        console.log('[Preload] Navigate to session event received:', params)
        callback(params)
      }
      ipcRenderer.on(IpcEvent.BILIBILI_NAVIGATE_TO_SESSION, listener)
      console.log('[Preload] Navigation listener registered')
      return () => {
        ipcRenderer.removeListener(IpcEvent.BILIBILI_NAVIGATE_TO_SESSION, listener)
      }
    },
  },

  // Clipboard utilities
  clipboard: {
    copyImage: (params: CopyImageParams): Promise<CopyImageResult> =>
      ipcRenderer.invoke(IpcChannel.CLIPBOARD_COPY_IMAGE, params),
  },

  // App menu event listeners
  onOpenAbout: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on(IpcEvent.APP_OPEN_ABOUT, listener)
    return () => {
      ipcRenderer.removeListener(IpcEvent.APP_OPEN_ABOUT, listener)
    }
  },
  onOpenSettings: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on(IpcEvent.APP_OPEN_SETTINGS, listener)
    return () => {
      ipcRenderer.removeListener(IpcEvent.APP_OPEN_SETTINGS, listener)
    }
  },

  // Update management
  checkForUpdates: (): Promise<CheckForUpdatesResult> => ipcRenderer.invoke(IpcChannel.APP_CHECK_FOR_UPDATES),
  onUpdateStatus: (callback: (status: UpdateStatusInfo) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatusInfo) => {
      callback(status)
    }
    ipcRenderer.on(IpcEvent.APP_UPDATE_STATUS, listener)
    return () => {
      ipcRenderer.removeListener(IpcEvent.APP_UPDATE_STATUS, listener)
    }
  },
})
