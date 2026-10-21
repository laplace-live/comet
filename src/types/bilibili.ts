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

// Message settings (link_setting/get), which answers only the optional fields it's asked for
export interface BilibiliLinkSettingResponse {
  code: number
  msg?: string
  message: string
  ttl: number
  data: {
    // 收起未关注人消息: 1 folds chats with people the user doesn't follow into 未关注人消息
    show_unfollowed_msg?: number
  }
}

// Unread counts by kind of chat (session_svr/single_unread)
export interface BilibiliSingleUnreadResponse {
  code: number
  msg?: string
  message: string
  ttl: number
  data: {
    unfollow_unread: number // Unread from people the user doesn't follow
    follow_unread: number // Unread from people the user follows
    unfollow_push_msg: number
    dustbin_push_msg: number
    dustbin_unread: number
    biz_msg_unfollow_unread: number
    biz_msg_follow_unread: number
    custom_unread: number
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
  // Customer service messages only: their sender, since only the user's has a real sender_uid
  customer_service_sender?: {
    type: number // See CS_SENDER_TYPE
    name: string
    face: string
  }
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

// Which sessions get_sessions lists (its session_type parameter), unlike SESSION_TYPE, which says what a session is
export const SESSION_LIST_TYPE = {
  USER_AND_SYSTEM: 1, // 用户与系统: the main list, which leaves out the chats unfollow_fold folds
  UNFOLLOWED: 2, // 未关注人: chats with people the user doesn't follow, as 未关注人消息 lists them
} as const

// System session type constants (session.system_msg_type)
export const SYSTEM_MSG_TYPE = {
  CUSTOMER_SERVICE: 8, // 客服消息 (backed by customerservice.bilibili.com, talker_id is 0)
} as const

// Session types that WebSocket notifications (notifyInfo.sessionType) give customer service chats,
// which the session list folds into the one SYSTEM_MSG_TYPE.CUSTOMER_SERVICE session
export const CUSTOMER_SERVICE_WS_SESSION_TYPES: ReadonlySet<number> = new Set([
  3, // Bilibili's own customer service
  4, // A store's customer service
])

// ============================================================================
// Customer Service Types (customerservice.bilibili.com)
// Each chat belongs to a shop: Bilibili's own customer service has shop_father_id 0, stores 1
// ============================================================================

// A sender or receiver of a customer service message, or the shop a chat is with
export interface CustomerServiceParticipant {
  type: number // See CS_SENDER_TYPE
  uid: number // The user's mid for the user, 0 for the bot
  shop_id: number
  shop_father_id: number
  customer_id: number
  machine_session_id: number
  customer_session_id: number
  name: string
  pic_url: string
  shop_homepage: string
  tags?: string[] | null
}

// Customer service message
export interface CustomerServiceMessage {
  sender_info: CustomerServiceParticipant
  receiver_info: CustomerServiceParticipant
  msg_type: number // See CS_MSG_TYPE
  content: string // Serialized JSON, shaped by msg_type
  // Ids are kept as strings: they exceed Number.MAX_SAFE_INTEGER
  msg_key: string
  seq_no: string
  timestamp: number
  msg_status: number
  msg_source: number
}

// Customer service chat, as get_sessions lists it
export interface CustomerServiceSession {
  talker_info: CustomerServiceParticipant
  last_msg: CustomerServiceMessage | null
  unread_info: { unread_count: number }
  session_ts: number // Microsecond timestamp
  max_seqno: string
  top_set: number
  do_not_disturb: boolean
  tag_name: string // e.g. 官方
}

export interface CustomerServiceSessionsResponse {
  code: number
  message: string
  ttl?: number
  data: {
    session_list: CustomerServiceSession[] | null
    has_more: number
  } | null
}

export interface CustomerServiceMessagesResponse {
  code: number
  message: string
  ttl?: number
  data: {
    messages: CustomerServiceMessage[] | null // Newest first
    has_more: number
    min_seqno: string
    max_seqno: string
    e_infos?: BilibiliEmojiInfo[]
  } | null
}

export interface CustomerServiceSendMessageResponse {
  code: number
  message: string
  ttl?: number
  data: { msg_key: string } | null
}

// Who sent a customer service message (sender_info.type)
export const CS_SENDER_TYPE = {
  MACHINE: 0, // The bot that answers first
  CUSTOMER: 1, // A human agent
  SYS_NOTICE: 2,
  USER: 3,
} as const

// Customer service message types; 1-17 share their meaning with MSG_TYPE
export const CS_MSG_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  WITHDRAW: 5,
  FAV_EMOJI: 6,
  VIDEO: 17,
  ORDER: 10001,
  GOODS: 10002,
  EVALUATION: 10003,
  TICKET: 10004, // 留言通知
  MACHINE_ANSWER: 10005, // The bot's answer, shaped by content.type
  MACHINE_QUESTION: 10006, // A question the user picked
  CUSTOMER_COME: 10007,
  MACHINE_WELCOME_TEXT: 10008,
  MACHINE_WELCOME_QUESTIONS: 10009,
  SPLIT_QUESTION: 10010,
  SPLIT_ANSWER: 10011, // Business choices or human agent queue state, shaped by content.type
  SWITCH_CUSTOMER: 10012,
  CUSTOMER_INVITE_EVALUATION: 10013,
  OUT_CUSTOMER_QUEUE: 10014,
  OUT_CUSTOMER_SESSION: 10015, // 会话已结束
  QUEUE_NOTICE: 10016,
  FORCE_SWITCH_CUSTOMER: 10017,
  CUSTOMER_INITIATIVE_MSG: 10018,
  SYS_NOTE: 10019,
  MACHINE_SESSION_EVALUATION: 10020,
  PARAGRAPH_TEXT: 10021,
  BUSINESS_LINK: 10022,
  SYS_BAR: 10023,
  ARCHIVE: 10027, // Video card
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
    wbi_img?: {
      img_url: string
      sub_url: string
    }
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
