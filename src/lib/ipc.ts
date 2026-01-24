/**
 * IPC Contract - Single Source of Truth for all IPC channels
 *
 * This file defines all IPC channel names and their associated types.
 * All main process handlers and preload bridge implementations should import from here.
 */

import type {
  BilibiliCredentials,
  BilibiliMessagesResponse,
  BilibiliSendMessageResponse,
  BilibiliSessionsResponse,
  BilibiliUserCardsResponse,
} from '@/types/bilibili'
import type {
  CheckForUpdatesResult,
  CheckLoginResult,
  CopyImageParams,
  CopyImageResult,
  ErrorResponse,
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
  UpdateAckResponse,
  UpdateStatusInfo,
  UploadImageParams,
  UploadImageResult,
  WSStatusResult,
} from '@/types/electron'

// ============================================================================
// IPC Channel Names - Invoke (renderer → main → response)
// ============================================================================

export const IpcChannel = {
  // App
  APP_GET_VERSION: 'app:get-version',
  APP_SET_BADGE_COUNT: 'app:set-badge-count',
  APP_CHECK_FOR_UPDATES: 'app:check-for-updates',

  // Notifications
  SHOW_NOTIFICATION: 'show-notification',

  // Clipboard
  CLIPBOARD_COPY_IMAGE: 'clipboard:copy-image',

  // Bilibili Auth
  BILIBILI_QR_GENERATE: 'bilibili:qr-generate',
  BILIBILI_QR_POLL: 'bilibili:qr-poll',
  BILIBILI_GET_CREDENTIALS: 'bilibili:get-credentials',
  BILIBILI_LOGOUT: 'bilibili:logout',
  BILIBILI_CHECK_LOGIN: 'bilibili:check-login',

  // Bilibili Multi-account
  BILIBILI_GET_ACCOUNTS: 'bilibili:get-accounts',
  BILIBILI_SET_ACTIVE_ACCOUNT: 'bilibili:set-active-account',
  BILIBILI_REMOVE_ACCOUNT: 'bilibili:remove-account',
  BILIBILI_REAUTH_ACCOUNT: 'bilibili:reauth-account',
  BILIBILI_REORDER_ACCOUNTS: 'bilibili:reorder-accounts',

  // Bilibili Data
  BILIBILI_FETCH_SESSIONS: 'bilibili:fetch-sessions',
  BILIBILI_FETCH_MESSAGES: 'bilibili:fetch-messages',
  BILIBILI_FETCH_USERS: 'bilibili:fetch-users',

  // Bilibili Actions
  BILIBILI_UPDATE_ACK: 'bilibili:update-ack',
  BILIBILI_SEND_MESSAGE: 'bilibili:send-message',
  BILIBILI_UPLOAD_IMAGE: 'bilibili:upload-image',
  BILIBILI_SET_DND: 'bilibili:set-dnd',

  // Bilibili WebSocket
  BILIBILI_WS_CONNECT: 'bilibili:ws-connect',
  BILIBILI_WS_DISCONNECT: 'bilibili:ws-disconnect',
  BILIBILI_WS_STATUS: 'bilibili:ws-status',
} as const

// ============================================================================
// IPC Event Names - Send (main → renderer, one-way)
// ============================================================================

export const IpcEvent = {
  // App menu events
  APP_OPEN_ABOUT: 'app:open-about',
  APP_OPEN_SETTINGS: 'app:open-settings',
  APP_UPDATE_STATUS: 'app:update-status',

  // Bilibili real-time events
  BILIBILI_NEW_MESSAGE: 'bilibili:new-message',
  BILIBILI_SESSION_UPDATE: 'bilibili:session-update',
  BILIBILI_WS_CONNECTED: 'bilibili:ws-connected',
  BILIBILI_WS_DISCONNECTED: 'bilibili:ws-disconnected',
  BILIBILI_NAVIGATE_TO_SESSION: 'bilibili:navigate-to-session',
} as const

// ============================================================================
// Type Definitions for IPC Contract
// ============================================================================

/**
 * Maps invoke channel names to their parameter and result types.
 * Used for type-safe IPC handling.
 */
export interface IpcInvokeContract {
  // App
  [IpcChannel.APP_GET_VERSION]: {
    params: undefined
    result: string
  }
  [IpcChannel.APP_SET_BADGE_COUNT]: {
    params: number
    result: { success: boolean; reason?: string }
  }
  [IpcChannel.APP_CHECK_FOR_UPDATES]: {
    params: undefined
    result: CheckForUpdatesResult
  }

  // Notifications
  [IpcChannel.SHOW_NOTIFICATION]: {
    params: ShowNotificationParams
    result: { shown: boolean; reason?: string }
  }

  // Clipboard
  [IpcChannel.CLIPBOARD_COPY_IMAGE]: {
    params: CopyImageParams
    result: CopyImageResult
  }

  // Bilibili Auth
  [IpcChannel.BILIBILI_QR_GENERATE]: {
    params: undefined
    result: QRGenerateResult
  }
  [IpcChannel.BILIBILI_QR_POLL]: {
    params: QRPollParams
    result: QRPollResult
  }
  [IpcChannel.BILIBILI_GET_CREDENTIALS]: {
    params: undefined
    result: BilibiliCredentials | null
  }
  [IpcChannel.BILIBILI_LOGOUT]: {
    params: undefined
    result: { success: boolean }
  }
  [IpcChannel.BILIBILI_CHECK_LOGIN]: {
    params: undefined
    result: CheckLoginResult
  }

  // Bilibili Multi-account
  [IpcChannel.BILIBILI_GET_ACCOUNTS]: {
    params: undefined
    result: GetAccountsResult
  }
  [IpcChannel.BILIBILI_SET_ACTIVE_ACCOUNT]: {
    params: SetActiveAccountParams
    result: SetActiveAccountResult
  }
  [IpcChannel.BILIBILI_REMOVE_ACCOUNT]: {
    params: RemoveAccountParams
    result: RemoveAccountResult
  }
  [IpcChannel.BILIBILI_REAUTH_ACCOUNT]: {
    params: ReauthAccountParams
    result: ReauthAccountResult
  }
  [IpcChannel.BILIBILI_REORDER_ACCOUNTS]: {
    params: ReorderAccountsParams
    result: ReorderAccountsResult
  }

  // Bilibili Data
  [IpcChannel.BILIBILI_FETCH_SESSIONS]: {
    params: FetchSessionsParams
    result: BilibiliSessionsResponse | ErrorResponse
  }
  [IpcChannel.BILIBILI_FETCH_MESSAGES]: {
    params: FetchMessagesParams
    result: BilibiliMessagesResponse | ErrorResponse
  }
  [IpcChannel.BILIBILI_FETCH_USERS]: {
    params: FetchUsersParams
    result: BilibiliUserCardsResponse | ErrorResponse
  }

  // Bilibili Actions
  [IpcChannel.BILIBILI_UPDATE_ACK]: {
    params: UpdateAckParams
    result: UpdateAckResponse | ErrorResponse
  }
  [IpcChannel.BILIBILI_SEND_MESSAGE]: {
    params: SendMessageParams
    result: BilibiliSendMessageResponse | ErrorResponse
  }
  [IpcChannel.BILIBILI_UPLOAD_IMAGE]: {
    params: UploadImageParams
    result: UploadImageResult
  }
  [IpcChannel.BILIBILI_SET_DND]: {
    params: SetDndParams
    result: SetDndResult
  }

  // Bilibili WebSocket
  [IpcChannel.BILIBILI_WS_CONNECT]: {
    params: undefined
    result: { success: boolean }
  }
  [IpcChannel.BILIBILI_WS_DISCONNECT]: {
    params: undefined
    result: { success: boolean }
  }
  [IpcChannel.BILIBILI_WS_STATUS]: {
    params: undefined
    result: WSStatusResult
  }
}

/**
 * Maps event channel names to their payload types.
 * Used for type-safe main → renderer communication.
 */
export interface IpcEventContract {
  [IpcEvent.APP_OPEN_ABOUT]: undefined
  [IpcEvent.APP_OPEN_SETTINGS]: undefined
  [IpcEvent.APP_UPDATE_STATUS]: UpdateStatusInfo
  [IpcEvent.BILIBILI_NEW_MESSAGE]: NewMessageNotification
  [IpcEvent.BILIBILI_SESSION_UPDATE]: SessionUpdateNotification
  [IpcEvent.BILIBILI_WS_CONNECTED]: undefined
  [IpcEvent.BILIBILI_WS_DISCONNECTED]: undefined
  [IpcEvent.BILIBILI_NAVIGATE_TO_SESSION]: NavigateToSessionParams
}

// ============================================================================
// Type Helpers
// ============================================================================

/** All invoke channel names */
export type IpcInvokeChannel = keyof IpcInvokeContract

/** All event channel names */
export type IpcEventChannel = keyof IpcEventContract

/** Get the params type for an invoke channel */
export type IpcParams<C extends IpcInvokeChannel> = IpcInvokeContract[C]['params']

/** Get the result type for an invoke channel */
export type IpcResult<C extends IpcInvokeChannel> = IpcInvokeContract[C]['result']

/** Get the payload type for an event channel */
export type IpcEventPayload<C extends IpcEventChannel> = IpcEventContract[C]
