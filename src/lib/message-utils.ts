import type { BilibiliMessage, BilibiliSession } from '@/types/bilibili'

import { MSG_TYPE } from '@/types/bilibili'

export interface UserCacheEntry {
  name: string
  face: string
  official?: {
    role: number
    title: string
    desc: string
    type: number
  }
  vip?: {
    type: number
    status: number
    nickname_color: string
  }
}

export interface UserCache {
  [mid: number]: UserCacheEntry
}

/**
 * Format timestamp to readable date
 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  // Less than 24 hours
  if (diff < 24 * 60 * 60 * 1000) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  // Less than 7 days
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return days[date.getDay()]
  }
  // Older than 1 year - show full date with year
  if (diff >= 365 * 24 * 60 * 60 * 1000) {
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
  }
  // Otherwise show month and day
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

/**
 * Format timestamp to absolute date and time
 */
export function formatAbsoluteTime(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * Safely extract string from content field (handles nested objects)
 */
function extractString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    // Handle nested content objects like {abs_text, pure_text, desc, ...}
    if (typeof obj.pure_text === 'string') return obj.pure_text
    if (typeof obj.abs_text === 'string') return obj.abs_text
    if (typeof obj.desc === 'string') return obj.desc
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.title === 'string') return obj.title
    if (typeof obj.content === 'string') return obj.content
  }
  return null
}

/**
 * Parse message content based on message type
 */
export function parseMessageContent(msg: BilibiliMessage): string {
  try {
    const content = JSON.parse(msg.content)

    switch (msg.msg_type) {
      case MSG_TYPE.TEXT:
        return extractString(content.content) || extractString(content) || ''
      case MSG_TYPE.IMAGE:
        return '[图片]'
      case MSG_TYPE.REVOKE:
        return '[已撤回的消息]'
      case MSG_TYPE.NOTIFICATION:
        return extractString(content.title) || extractString(content.text) || '[通知]'
      case MSG_TYPE.VIDEO_PUSH:
        return `[视频] ${extractString(content.title) || ''}`
      default: {
        const result =
          extractString(content.content) ||
          extractString(content.text) ||
          extractString(content.title) ||
          extractString(content)
        return result || '[未知消息类型]'
      }
    }
  } catch {
    // If content is not JSON, return as-is if it's a string
    return typeof msg.content === 'string' ? msg.content : '[无法解析的消息]'
  }
}

/**
 * Get session display name
 */
export function getSessionName(session: BilibiliSession, userCache?: UserCache): string {
  if (session.account_info?.name) {
    return session.account_info.name
  }
  if (session.group_name) {
    return session.group_name
  }
  // Check user cache
  const cachedUser = userCache?.[session.talker_id]
  if (cachedUser?.name) {
    return cachedUser.name
  }
  return `用户 ${session.talker_id}`
}

/**
 * Get session avatar URL
 */
export function getSessionAvatar(session: BilibiliSession, userCache?: UserCache): string | null {
  if (session.account_info?.pic_url) {
    return session.account_info.pic_url
  }
  if (session.group_cover) {
    return session.group_cover
  }
  // Check user cache
  const cachedUser = userCache?.[session.talker_id]
  if (cachedUser?.face) {
    return cachedUser.face
  }
  return null
}

/**
 * Get last message preview text
 */
export function getLastMessagePreview(session: BilibiliSession): string {
  if (!session.last_msg) return ''
  return parseMessageContent(session.last_msg)
}
