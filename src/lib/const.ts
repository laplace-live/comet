// ============================================================================
// User Agent
// ============================================================================

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

// ============================================================================
// Bilibili API Base URLs
// ============================================================================

export const BILIBILI_API = {
  /** Main API endpoint */
  MAIN: 'https://api.bilibili.com',
  /** Passport/authentication API */
  PASSPORT: 'https://passport.bilibili.com',
  /** VC (Video Community) API - used for messaging */
  VC: 'https://api.vc.bilibili.com',
  /** Message center */
  MESSAGE: 'https://message.bilibili.com',
  /** Broadcast WebSocket */
  BROADCAST_WS: 'wss://broadcast.chat.bilibili.com:7826',
} as const

// ============================================================================
// Bilibili API Endpoints
// ============================================================================

export const BILIBILI_ENDPOINTS = {
  // Authentication
  /** Generate QR code for login */
  QR_GENERATE: `${BILIBILI_API.PASSPORT}/x/passport-login/web/qrcode/generate`,
  /** Poll QR code login status */
  QR_POLL: `${BILIBILI_API.PASSPORT}/x/passport-login/web/qrcode/poll`,
  /** Check login status / get current user info */
  NAV: `${BILIBILI_API.MAIN}/x/web-interface/nav`,

  // Messaging
  /** Get sessions (conversation list) */
  GET_SESSIONS: `${BILIBILI_API.VC}/session_svr/v1/session_svr/get_sessions`,
  /** Fetch messages from a session */
  FETCH_MESSAGES: `${BILIBILI_API.VC}/svr_sync/v1/svr_sync/fetch_session_msgs`,
  /** Send a message */
  SEND_MESSAGE: `${BILIBILI_API.VC}/web_im/v1/web_im/send_msg`,
  /** Mark session as read (update acknowledgment) */
  UPDATE_ACK: `${BILIBILI_API.VC}/session_svr/v1/session_svr/update_ack`,

  // User Info
  /** Fetch user info in batch */
  USER_INFOS: `${BILIBILI_API.VC}/x/im/user_infos`,

  // Image Upload
  /** Upload image for dynamic/private messages (returns Bilibili CDN URL) */
  UPLOAD_IMAGE: `${BILIBILI_API.MAIN}/x/dynamic/feed/draw/upload_bfs`,

  // WebSocket
  /** Broadcast WebSocket for real-time notifications */
  BROADCAST_WS: `${BILIBILI_API.BROADCAST_WS}/sub`,
} as const

// ============================================================================
// HTTP Headers
// ============================================================================

export const BILIBILI_HEADERS = {
  /** Referer header for messaging APIs */
  REFERER: `${BILIBILI_API.MESSAGE}/`,
  /** Origin header for messaging APIs */
  ORIGIN: BILIBILI_API.MESSAGE,
} as const

// ============================================================================
// WebSocket Configuration
// ============================================================================

export const WEBSOCKET_CONFIG = {
  /** Heartbeat interval in milliseconds (20 seconds) */
  HEARTBEAT_INTERVAL: 20000,
  /** Reconnect delay in milliseconds (5 seconds) */
  RECONNECT_DELAY: 5000,
} as const

// ============================================================================
// Image Upload Configuration
// ============================================================================

/** Image format configuration - single source of truth */
export const IMAGE_FORMATS: Record<string, { extension: string; type: string }> = {
  'image/jpeg': { extension: 'jpg', type: 'jpeg' },
  'image/jpg': { extension: 'jpg', type: 'jpeg' },
  'image/png': { extension: 'png', type: 'png' },
  'image/gif': { extension: 'gif', type: 'gif' },
  'image/webp': { extension: 'webp', type: 'webp' },
}

/** Supported image MIME types for upload */
export const SUPPORTED_IMAGE_MIME_TYPES = Object.keys(IMAGE_FORMATS)

/** Get file extension for a MIME type */
export const getImageExtension = (mimeType: string): string => IMAGE_FORMATS[mimeType]?.extension ?? 'jpg'

/** Get image type name for a MIME type */
export const getImageType = (mimeType: string): string => IMAGE_FORMATS[mimeType]?.type ?? 'jpeg'

/** Maximum image file size in bytes (20MB) */
export const MAX_IMAGE_SIZE = 20 * 1024 * 1024
