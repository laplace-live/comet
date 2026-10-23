// ============================================================================
// User Agent
// ============================================================================

/** Also in packages/bilibili-qr/src/constants.ts, for its DEFAULT_HEADERS: this file can't import the package */
export const CHROME_VERSION = '149'

export const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`

// ============================================================================
// Bilibili API Base URLs
// ============================================================================

export const BILIBILI_API = {
  /** Main API endpoint */
  MAIN: 'https://api.bilibili.com',
  /** VC (Video Community) API - used for messaging */
  VC: 'https://api.vc.bilibili.com',
  /** Message center */
  MESSAGE: 'https://message.bilibili.com',
  /** Customer service chats (客服消息), separate from the VC messaging backend */
  CUSTOMER_SERVICE: 'https://customerservice.bilibili.com',
  /** Broadcast WebSocket */
  BROADCAST_WS: 'wss://broadcast.chat.bilibili.com:7826',
} as const

// ============================================================================
// HTTP Headers
// ============================================================================

/** Client Hints for Chrome on Windows */
export const CLIENT_HINTS = {
  'sec-ch-ua': `"Not(A:Brand";v="8", "Chromium";v="${CHROME_VERSION}", "Google Chrome";v="${CHROME_VERSION}"`,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
} as const

/** Sec-Fetch headers for different request contexts */
export const SEC_FETCH = {
  /** For API/XHR requests */
  API: {
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
  },
  /** For navigation requests */
  NAVIGATE: {
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
  },
} as const

export const BILIBILI_HEADERS = {
  /** Referer header for messaging APIs */
  REFERER: `${BILIBILI_API.MESSAGE}/`,
  /** Origin header for messaging APIs */
  ORIGIN: BILIBILI_API.MESSAGE,
} as const

/** Common headers for Bilibili API requests */
export const COMMON_HEADERS = {
  'User-Agent': USER_AGENT,
  ...CLIENT_HINTS,
  ...SEC_FETCH.API,
} as const

// ============================================================================
// Bilibili API Endpoints
// ============================================================================

export const BILIBILI_ENDPOINTS = {
  // Authentication (QR code login itself goes through @laplace.live/bilibili-qr)
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
  /** Set Do Not Disturb status for a session */
  SET_DND: `${BILIBILI_API.VC}/link_setting/v1/link_setting/set_msg_dnd`,
  /** Pin/unpin (sticky) a session */
  SET_TOP: `${BILIBILI_API.VC}/session_svr/v1/session_svr/set_top`,
  /** Unread counts by kind of chat (followed, unfollowed, …) */
  SINGLE_UNREAD: `${BILIBILI_API.VC}/session_svr/v1/session_svr/single_unread`,
  /** Read the account's message settings */
  GET_LINK_SETTING: `${BILIBILI_API.VC}/link_setting/v1/link_setting/get`,
  /** Change the account's message settings */
  SET_LINK_SETTING: `${BILIBILI_API.VC}/link_setting/v1/link_setting/set`,

  // Customer service
  /** Get customer service chats, one per shop */
  CUSTOMER_SERVICE_GET_SESSIONS: `${BILIBILI_API.CUSTOMER_SERVICE}/x/custom/session_svr/v1/get_sessions`,
  /** Fetch messages from a customer service chat (Wbi-signed) */
  CUSTOMER_SERVICE_FETCH_MESSAGES: `${BILIBILI_API.CUSTOMER_SERVICE}/x/custom/session_svr/v1/fetch_sess_msg`,
  /** Send a message to a customer service chat (Wbi-signed) */
  CUSTOMER_SERVICE_SEND_MESSAGE: `${BILIBILI_API.CUSTOMER_SERVICE}/x/custom/msg_svr/v1/send_msg`,
  /** Mark a customer service chat as read */
  CUSTOMER_SERVICE_UPDATE_ACK: `${BILIBILI_API.CUSTOMER_SERVICE}/x/custom/session_svr/v1/update_ack`,
  /** Upload an image for a customer service message */
  CUSTOMER_SERVICE_UPLOAD_IMAGE: `${BILIBILI_API.CUSTOMER_SERVICE}/x/custom/call_svr/v1/upload_bfs`,

  // Risk control / device fingerprint
  /** Fetch buvid3/buvid4 device fingerprint cookies (gaia risk control) */
  FINGER_SPI: `${BILIBILI_API.MAIN}/x/frontend/finger/spi`,

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
// WebSocket Configuration
// ============================================================================

export const WEBSOCKET_CONFIG = {
  /** Heartbeat interval in milliseconds (20 seconds) */
  HEARTBEAT_INTERVAL: 20000,
  /** Reconnect delay in milliseconds (5 seconds) */
  RECONNECT_DELAY: 5000,
} as const

// ============================================================================
// Login Configuration
// ============================================================================

export const LOGIN_CONFIG = {
  /** Deadline for a single login-related request in milliseconds (15 seconds) */
  REQUEST_TIMEOUT: 15_000,
  /** Delay between QR code status polls in milliseconds (3 seconds) */
  QR_POLL_INTERVAL: 3000,
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

// ============================================================================
// Auto-Update Configuration
// ============================================================================

/**
 * Base URL for auto-updates served from Cloudflare R2.
 *
 * The update server should serve files in this structure:
 * - Windows: {baseUrl}/win32/x64/RELEASES, *.nupkg, *.exe
 * - macOS:   {baseUrl}/darwin/{arch}/RELEASES.json, *.zip
 *
 * Update this URL to your R2 bucket's public URL (custom domain or r2.dev)
 * plus the key prefix the workflow uploads to.
 * Example: 'https://downloads.example.com/comet'
 */
export const UPDATE_BASE_URL = 'https://downloads.vrp.moe/comet'
