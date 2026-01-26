/**
 * Bilibili Private Message API Types
 * Based on: https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/message/private_msg.md
 */

// Last message in a session
export interface BilibiliLastMessage {
  sender_uid: number
  receiver_type: number
  receiver_id: number
  msg_type: number
  content: string
  msg_seqno: number
  timestamp: number
  at_uids: number[] | null
  // msg_key is stored as string to preserve precision (values exceed Number.MAX_SAFE_INTEGER)
  msg_key: number | string
  msg_status: number
  notify_code: string
  new_face_version?: number
  msg_source: number
}

// Account info for system sessions
export interface BilibiliAccountInfo {
  name: string
  pic_url: string
}

// Session object
export interface BilibiliSession {
  talker_id: number
  session_type: number
  at_seqno: number
  top_ts: number
  group_name: string
  group_cover: string
  is_follow: number
  is_dnd: number
  ack_seqno: number
  ack_ts: number
  session_ts: number
  unread_count: number
  last_msg: BilibiliLastMessage | null
  group_type: number
  can_fold: number
  status: number
  max_seqno: number
  new_push_msg: number
  setting: number
  is_guardian: number
  is_intercept: number
  is_trust: number
  system_msg_type: number
  account_info?: BilibiliAccountInfo
  live_status: number
  biz_msg_unread_count: number
  user_label: unknown
}

// Get sessions response
export interface BilibiliSessionsResponse {
  code: number
  msg: string
  message: string
  ttl: number
  data: {
    session_list: BilibiliSession[] | null
    has_more: number
    anti_disturb_cleaning: boolean
    is_address_list_empty: number
    system_msg?: Record<string, number>
    show_level: boolean
  }
}

// Emoji info
export interface BilibiliEmojiInfo {
  text: string
  url: string
  size: number
  gif_url?: string
}

// Private message object
export interface BilibiliMessage {
  sender_uid: number
  receiver_type: number
  receiver_id: number
  msg_type: number
  content: string
  msg_seqno: number
  timestamp: number
  at_uids: number[] | null
  // msg_key is stored as string to preserve precision (values exceed Number.MAX_SAFE_INTEGER)
  msg_key: number | string
  msg_status: number
  notify_code: string
  new_face_version?: number
  msg_source: number
  sys_cancel?: boolean
}

// Fetch messages response
export interface BilibiliMessagesResponse {
  code: number
  msg: string
  message: string
  ttl: number
  data: {
    messages: BilibiliMessage[] | null
    has_more: number
    min_seqno: number
    max_seqno: number
    e_infos?: BilibiliEmojiInfo[]
  }
}

// User info response (for getting user details)
export interface BilibiliUserInfo {
  mid: number
  name: string
  face: string
  sign: string
  level: number
  official: {
    role: number
    title: string
    desc: string
  }
  vip: {
    type: number
    status: number
  }
}

export interface BilibiliUserInfoResponse {
  code: number
  message: string
  ttl: number
  data: BilibiliUserInfo
}

// Batch user info response (多用户详细信息3)
// API: https://api.vc.bilibili.com/x/im/user_infos
export interface BilibiliUserCard {
  mid: number
  name: string
  face: string
  sign: string
  rank: number
  level: number
  silence: number
  vip: {
    type: number
    status: number
    due_date: number
    nickname_color: string
  }
  official: {
    role: number
    title: string
    desc: string
    type: number
  }
}

export interface BilibiliUserCardsResponse {
  code: number
  msg: string
  message: string
  ttl: number
  data: BilibiliUserCard[]
}

// Message content types
export interface TextMessageContent {
  content: string
}

export interface ImageMessageContent {
  url: string
  height: number
  width: number
  imageType: string
  original: number
  size: number
}

export interface RevokeMessageContent {
  content: string
}

export interface NotificationMessageContent {
  title: string
  text: string
  jump_text?: string
  jump_uri?: string
  jump_uri_config?: {
    all_uri?: string
    text?: string
  }
}

export interface VideoPushMessageContent {
  title: string
  desc?: string
  cover: string
  rid: number
  bvid?: string
  type_?: number
  times?: number
  view?: number
  danmaku?: number
  pub_date?: number
  attach_msg?: string | null
}

export interface ShareMessageContent {
  title?: string
  source?: string
  desc?: string
  cover?: string
  url?: string
  id?: number
  sketch?: {
    title?: string
    desc_text?: string
    cover_url?: string
    target_url?: string
    biz_type?: number
  }
}

export interface CustomEmojiContent {
  url: string
  width: number
  height: number
}

export interface FanGroupSystemContent {
  group_id: number
  content: string
}

// System tip content (msg_type 18)
// The content field contains a serialized JSON array string
export interface SystemTipItem {
  text: string
  color_day: string
  color_nig: string
  jump_url?: string
}

export interface SystemTipContent {
  content: string // Serialized JSON array of SystemTipItem
}

// AI generated message content (msg_type 52)
export interface AiGeneratedWordNode {
  node_type: number
  raw_text: string
  word?: {
    words: string
    font_size?: number
  }
}

export interface AiGeneratedParagraph {
  para_type: number
  text?: {
    nodes: AiGeneratedWordNode[]
  }
}

export interface AiGeneratedMessageContent {
  paragraphs: AiGeneratedParagraph[]
  show_like?: number
  show_change?: number
  gpt_session_id?: number
  gpt_bind_query?: string
  session_closed_line?: string
  voice_url?: string
  sub_type?: number
  voice_time?: number
}

// Message type constants
export const MSG_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  REVOKE: 5,
  CUSTOM_EMOJI: 6, // 自定义表情
  SHARE: 7, // 分享卡片
  NOTIFICATION: 10,
  VIDEO_PUSH: 11,
  LOTTERY: 13,
  SYSTEM_TIP: 18,
  MINI_PROGRAM: 21, // 小程序
  ARTICLE: 22, // 专栏
  LIVE_CARD: 27, // 直播卡片
  AI_GENERATED: 52, // AI/LLM 生成的消息
  FAN_GROUP_SYSTEM: 306, // 粉丝团系统消息
} as const

// Message types that are NOT private messages and should be ignored by the WebSocket handler
// These are platform-wide notifications (likes, follows, etc.) that are not relevant to PM
export const IGNORED_WS_MSG_TYPES: ReadonlySet<number> = new Set([
  108, // 关注事件 (Follow event)
  113, // 被评论通知 (Comment notification)
  114, // @我的 (Mentioned notification)
  115, // 被点赞通知 (Like notification)
])

// Message source constants
export const MSG_SOURCE = {
  UNKNOWN: 0,
  IOS: 1,
  ANDROID: 2,
  H5: 3,
  PC_CLIENT: 4,
  OFFICIAL_PUSH: 5,
  PUSH_NOTIFICATION: 6,
  WEB: 7,
  AUTO_REPLY_FOLLOW: 8,
  AUTO_REPLY_MESSAGE: 9,
  AUTO_REPLY_KEYWORD: 10,
  AUTO_REPLY_CAPTAIN: 11,
  AUTO_PUSH_UP_MESSAGE: 12,
  FAN_GROUP_SYSTEM: 13,
  SYSTEM: 16,
  MUTUAL_FOLLOW: 17,
  SYSTEM_TIP: 18,
  AI: 19,
} as const

// Session type constants
export const SESSION_TYPE = {
  USER: 1,
  FAN_GROUP: 2,
} as const

// QR Code Login Types
export interface BilibiliQRCodeGenerateResponse {
  code: number
  message: string
  ttl: number
  data: {
    url: string
    qrcode_key: string
  }
}

export interface BilibiliQRCodePollResponse {
  code: number
  message: string
  ttl: number
  data: {
    url: string
    refresh_token: string
    timestamp: number
    code: number // 0: success, 86101: waiting for scan, 86090: scanned waiting for confirm, 86038: expired
    message: string
  }
}

// QR Code Poll Status
export const QR_CODE_STATUS = {
  SUCCESS: 0,
  WAITING_SCAN: 86101,
  WAITING_CONFIRM: 86090,
  EXPIRED: 86038,
} as const

// Stored login credentials
export interface BilibiliCredentials {
  SESSDATA: string
  DedeUserID: number
  DedeUserID__ckMd5?: string
  bili_jct: string
}

// Nav response (for checking login status)
export interface BilibiliNavResponse {
  code: number
  message: string
  ttl: number
  data: {
    isLogin: boolean
    mid?: number
    uname?: string
    face?: string
  }
}

// Send message response
export interface BilibiliSendMessageResponse {
  code: number
  message: string
  ttl?: number
  data: {
    // msg_key may be a string to preserve precision for large integers
    msg_key: number | string
    e_infos?: BilibiliEmojiInfo[]
    msg_content?: string
    key_hit_infos?: {
      toast?: string
      rule_id?: number
      high_text?: Array<Record<string, unknown>>
    }
  } | null
}

// Image upload response
export interface BilibiliImageUploadResponse {
  code: number
  message: string
  ttl?: number
  data: {
    image_url: string
    image_width: number
    image_height: number
  } | null
}
