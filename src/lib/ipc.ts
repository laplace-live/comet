/**
 * IPC Contract - Single Source of Truth for all IPC channels
 *
 * This file defines all IPC channel names and their associated types.
 * All main process handlers and preload bridge implementations should import from here.
 */

import type { AccountSnapshot, ChatMatch, SavedChat } from '@/lib/account-cache'
import type { SystemNotificationSoundOption } from '@/lib/notification-sounds'
import type {
  BilibiliCredentials,
  BilibiliLinkSettingResponse,
  BilibiliMessagesResponse,
  BilibiliSendMessageResponse,
  BilibiliSessionsResponse,
  BilibiliSingleUnreadResponse,
  BilibiliUserCardsResponse,
  CustomerServiceMessagesResponse,
  CustomerServiceSendMessageResponse,
  CustomerServiceSessionsResponse,
} from '@/types/bilibili'
import type {
  AccountParams,
  CachedChatParams,
  CachedListsParams,
  CheckForUpdatesResult,
  CheckLoginResult,
  CopyImageParams,
  CopyImageResult,
  CustomerServiceShop,
  ErrorResponse,
  FetchCustomerServiceMessagesParams,
  FetchMessagesParams,
  FetchSessionsParams,
  FetchUsersParams,
  GetAccountsResult,
  NavigateToSessionParams,
  NewMessageNotification,
  NotificationSoundParams,
  PlayNotificationSoundEvent,
  QRGenerateResult,
  QRPollParams,
  QRPollResult,
  ReauthAccountParams,
  ReauthAccountResult,
  RemoveAccountParams,
  RemoveAccountResult,
  ReorderAccountsParams,
  ReorderAccountsResult,
  SaveCachedChatParams,
  SaveCachedListsParams,
  SearchCachedChatsParams,
  SendCustomerServiceMessageParams,
  SendMessageParams,
  SessionUpdateNotification,
  SetActiveAccountParams,
  SetActiveAccountResult,
  SetDndParams,
  SetDndResult,
  SetTopParams,
  SetTopResult,
  SetUnfollowFoldParams,
  SetUnfollowFoldResult,
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
  NOTIFICATION_SOUNDS_LIST_SYSTEM: 'notification-sounds:list-system',
  NOTIFICATION_SOUNDS_READ_DATA: 'notification-sounds:read-data',
  NOTIFICATION_SOUNDS_PREVIEW: 'notification-sounds:preview',
  NOTIFICATION_SOUNDS_SET_SYSTEM_PREF: 'notification-sounds:set-system-pref',

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
  BILIBILI_FETCH_SINGLE_UNREAD: 'bilibili:fetch-single-unread',
  BILIBILI_FETCH_LINK_SETTING: 'bilibili:fetch-link-setting',

  // Bilibili Actions
  BILIBILI_UPDATE_ACK: 'bilibili:update-ack',
  BILIBILI_SEND_MESSAGE: 'bilibili:send-message',
  BILIBILI_UPLOAD_IMAGE: 'bilibili:upload-image',
  BILIBILI_SET_DND: 'bilibili:set-dnd',
  BILIBILI_SET_TOP: 'bilibili:set-top',
  BILIBILI_SET_UNFOLLOW_FOLD: 'bilibili:set-unfollow-fold',

  // Bilibili Customer Service
  BILIBILI_CUSTOMER_SERVICE_FETCH_SESSIONS: 'bilibili:customer-service-fetch-sessions',
  BILIBILI_CUSTOMER_SERVICE_FETCH_MESSAGES: 'bilibili:customer-service-fetch-messages',
  BILIBILI_CUSTOMER_SERVICE_SEND_MESSAGE: 'bilibili:customer-service-send-message',
  BILIBILI_CUSTOMER_SERVICE_UPDATE_ACK: 'bilibili:customer-service-update-ack',
  BILIBILI_CUSTOMER_SERVICE_UPLOAD_IMAGE: 'bilibili:customer-service-upload-image',

  // Bilibili accounts' cache on disk
  BILIBILI_CACHE_LOAD_LISTS: 'bilibili:cache-load-lists',
  BILIBILI_CACHE_SAVE_LISTS: 'bilibili:cache-save-lists',
  BILIBILI_CACHE_LOAD_CHAT: 'bilibili:cache-load-chat',
  BILIBILI_CACHE_SAVE_CHAT: 'bilibili:cache-save-chat',
  BILIBILI_CACHE_SEARCH_CHATS: 'bilibili:cache-search-chats',
  BILIBILI_CACHE_CLEAR: 'bilibili:cache-clear',

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
  APP_PLAY_NOTIFICATION_SOUND: 'app:play-notification-sound',

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
  [IpcChannel.NOTIFICATION_SOUNDS_LIST_SYSTEM]: {
    params: undefined
    result: SystemNotificationSoundOption[]
  }
  [IpcChannel.NOTIFICATION_SOUNDS_READ_DATA]: {
    params: NotificationSoundParams
    result: Uint8Array | null
  }
  [IpcChannel.NOTIFICATION_SOUNDS_PREVIEW]: {
    params: NotificationSoundParams
    result: undefined
  }
  [IpcChannel.NOTIFICATION_SOUNDS_SET_SYSTEM_PREF]: {
    params: NotificationSoundParams
    result: undefined
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
  [IpcChannel.BILIBILI_FETCH_SINGLE_UNREAD]: {
    params: AccountParams | undefined
    result: BilibiliSingleUnreadResponse | ErrorResponse
  }
  [IpcChannel.BILIBILI_FETCH_LINK_SETTING]: {
    params: AccountParams | undefined
    result: BilibiliLinkSettingResponse | ErrorResponse
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
  [IpcChannel.BILIBILI_SET_TOP]: {
    params: SetTopParams
    result: SetTopResult
  }
  [IpcChannel.BILIBILI_SET_UNFOLLOW_FOLD]: {
    params: SetUnfollowFoldParams
    result: SetUnfollowFoldResult
  }

  // Bilibili Customer Service
  [IpcChannel.BILIBILI_CUSTOMER_SERVICE_FETCH_SESSIONS]: {
    params: undefined
    result: CustomerServiceSessionsResponse | ErrorResponse
  }
  [IpcChannel.BILIBILI_CUSTOMER_SERVICE_FETCH_MESSAGES]: {
    params: FetchCustomerServiceMessagesParams
    result: CustomerServiceMessagesResponse | ErrorResponse
  }
  [IpcChannel.BILIBILI_CUSTOMER_SERVICE_SEND_MESSAGE]: {
    params: SendCustomerServiceMessageParams
    result: CustomerServiceSendMessageResponse | ErrorResponse
  }
  [IpcChannel.BILIBILI_CUSTOMER_SERVICE_UPDATE_ACK]: {
    params: CustomerServiceShop
    result: UpdateAckResponse | ErrorResponse
  }
  [IpcChannel.BILIBILI_CUSTOMER_SERVICE_UPLOAD_IMAGE]: {
    params: UploadImageParams
    result: UploadImageResult
  }

  // Bilibili accounts' cache on disk
  [IpcChannel.BILIBILI_CACHE_LOAD_LISTS]: {
    params: CachedListsParams
    result: AccountSnapshot | null
  }
  [IpcChannel.BILIBILI_CACHE_SAVE_LISTS]: {
    params: SaveCachedListsParams
    result: undefined
  }
  [IpcChannel.BILIBILI_CACHE_LOAD_CHAT]: {
    params: CachedChatParams
    result: SavedChat | null
  }
  [IpcChannel.BILIBILI_CACHE_SAVE_CHAT]: {
    params: SaveCachedChatParams
    result: undefined
  }
  [IpcChannel.BILIBILI_CACHE_SEARCH_CHATS]: {
    params: SearchCachedChatsParams
    result: ChatMatch[]
  }
  [IpcChannel.BILIBILI_CACHE_CLEAR]: {
    params: undefined
    result: undefined
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
  [IpcEvent.APP_PLAY_NOTIFICATION_SOUND]: PlayNotificationSoundEvent
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
