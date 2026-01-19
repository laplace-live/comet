import {
  Bot,
  ChevronRight,
  Code,
  ExternalLink,
  Image as ImageIcon,
  MessageSquareText,
  Undo2,
  User,
  Users,
} from 'lucide-react'

import type { EmojiInfoMap } from '@/hooks/usePrivateMessages'
import type { UserCache } from '@/lib/message-utils'
import type { BilibiliMessage, BilibiliSession } from '@/types/bilibili'
import type { CheckLoginResult } from '@/types/electron'

import { MSG_SOURCE, MSG_TYPE, SESSION_TYPE } from '@/types/bilibili'

import { formatAbsoluteTime, formatTime, getSessionAvatar } from '@/lib/message-utils'
import { cn } from '@/lib/utils'

import { enforceHttps } from '@/utils/enforceHttps'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { toastManager } from '@/components/ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'

interface MessageBubbleProps {
  message: BilibiliMessage
  emojiInfoMap: EmojiInfoMap
  isSent: boolean
  session: BilibiliSession
  userCache: UserCache
  userInfo: CheckLoginResult | null
  onRecall?: (msgSeqno: number, msgKeyStr: string) => Promise<{ success: boolean; error?: string }>
}

// Get message source label
function getMessageSourceLabel(msgSource: number): string | null {
  switch (msgSource) {
    case MSG_SOURCE.UNKNOWN:
      return null
    case MSG_SOURCE.IOS:
      return 'iOS'
    case MSG_SOURCE.ANDROID:
      return 'Android'
    case MSG_SOURCE.H5:
      return 'H5'
    case MSG_SOURCE.PC_CLIENT:
      return 'PC客户端'
    case MSG_SOURCE.OFFICIAL_PUSH:
      return '官方推送'
    case MSG_SOURCE.PUSH_NOTIFICATION:
      return '推送通知'
    case MSG_SOURCE.WEB:
      return 'Web'
    case MSG_SOURCE.AUTO_REPLY_FOLLOW:
      return '自动回复 · 关注'
    case MSG_SOURCE.AUTO_REPLY_MESSAGE:
      return '自动回复 · 消息'
    case MSG_SOURCE.AUTO_REPLY_KEYWORD:
      return '自动回复 · 关键词'
    case MSG_SOURCE.AUTO_REPLY_CAPTAIN:
      return '自动回复 · 大航海'
    case MSG_SOURCE.AUTO_PUSH_UP_MESSAGE:
      return 'UP主赠言'
    case MSG_SOURCE.FAN_GROUP_SYSTEM:
      return '粉丝团系统'
    case MSG_SOURCE.SYSTEM:
      return '系统'
    case MSG_SOURCE.MUTUAL_FOLLOW:
      return '互相关注'
    case MSG_SOURCE.SYSTEM_TIP:
      return '系统提示'
    case MSG_SOURCE.AI:
      return 'AI'
    default:
      return `来源 ${msgSource}`
  }
}

// Auto-reply message sources
const AUTO_REPLY_SOURCES: number[] = [
  MSG_SOURCE.AUTO_REPLY_FOLLOW,
  MSG_SOURCE.AUTO_REPLY_MESSAGE,
  MSG_SOURCE.AUTO_REPLY_KEYWORD,
  MSG_SOURCE.AUTO_REPLY_CAPTAIN,
]

// Check if the message source is an auto-reply type
function isAutoReplySource(msgSource: number): boolean {
  return AUTO_REPLY_SOURCES.includes(msgSource)
}

// Parse and render message content based on type
function renderMessageContent(message: BilibiliMessage, emojiInfoMap: EmojiInfoMap): React.ReactNode {
  try {
    const content = JSON.parse(message.content)

    switch (message.msg_type) {
      case MSG_TYPE.TEXT:
        return renderTextContent(content, emojiInfoMap)

      case MSG_TYPE.IMAGE:
        return renderImageContent(content)

      case MSG_TYPE.CUSTOM_EMOJI:
        return renderCustomEmojiContent(content)

      case MSG_TYPE.REVOKE:
        return renderRevokeContent()

      case MSG_TYPE.NOTIFICATION:
        return renderNotificationContent(content)

      case MSG_TYPE.VIDEO_PUSH:
        return renderVideoPushContent(content)

      case MSG_TYPE.SHARE:
        return renderShareContent(content)

      case MSG_TYPE.FAN_GROUP_SYSTEM:
        return renderFanGroupSystemContent(content)

      case MSG_TYPE.SYSTEM_TIP:
        return renderSystemTipContent(content)

      default:
        return renderDefaultContent(content, message.msg_type)
    }
  } catch {
    // If content is not JSON, render as plain text
    return (
      <p className='wrap-break-word whitespace-break-spaces text-sm leading-relaxed'>
        {typeof message.content === 'string' ? message.content : '[无法解析的消息]'}
      </p>
    )
  }
}

// Safely extract string from any value
function extractTextContent(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    // Handle nested objects like {id, content} or {text, ...}
    if (typeof obj.content === 'string') return obj.content
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.title === 'string') return obj.title
    if (typeof obj.desc === 'string') return obj.desc
    if (typeof obj.pure_text === 'string') return obj.pure_text
    if (typeof obj.abs_text === 'string') return obj.abs_text
    // Recursively extract from nested content
    if (obj.content && typeof obj.content === 'object') {
      return extractTextContent(obj.content)
    }
  }
  return ''
}

// Parse text and replace emoji codes with inline images
function parseTextWithEmojis(text: string, emojiInfoMap: EmojiInfoMap): React.ReactNode[] {
  if (!text) return []

  // Match emoji codes like [tv_doge], [口罩], etc.
  const emojiPattern = /\[([^\]]+)\]/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  // biome-ignore lint/suspicious/noAssignInExpressions: regex exec loop pattern
  while ((match = emojiPattern.exec(text)) !== null) {
    const emojiCode = match[0] // Full match including brackets, e.g., "[tv_doge]"
    const startIndex = match.index

    // Add text before this emoji
    if (startIndex > lastIndex) {
      parts.push(text.slice(lastIndex, startIndex))
    }

    // Check if we have info for this emoji
    const emojiInfo = emojiInfoMap[emojiCode]
    if (emojiInfo) {
      // Use gif_url if available, otherwise use regular url
      const emojiUrl = enforceHttps(emojiInfo.gif_url || emojiInfo.url)
      // Size 1 = small (inline), Size 2 = large
      const isLarge = emojiInfo.size === 2
      parts.push(
        <img
          key={`${startIndex}-${emojiCode}`}
          src={emojiUrl}
          alt={emojiCode}
          title={emojiCode}
          className={isLarge ? 'inline-block h-12 align-text-bottom' : 'inline-block h-5 align-text-bottom'}
          loading='lazy'
          referrerPolicy='no-referrer'
        />
      )
    } else {
      // No emoji info available, keep the text as-is
      parts.push(emojiCode)
    }

    lastIndex = startIndex + emojiCode.length
  }

  // Add remaining text after last emoji
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

// Text message
function renderTextContent(content: { content?: unknown }, emojiInfoMap: EmojiInfoMap): React.ReactNode {
  const text = extractTextContent(content.content) || extractTextContent(content)
  if (!text) {
    return <p className='wrap-break-word whitespace-break-spaces break-all text-sm leading-relaxed'>[空消息]</p>
  }

  const parsedContent = parseTextWithEmojis(text, emojiInfoMap)

  return <p className='wrap-break-word whitespace-break-spaces break-all text-sm leading-relaxed'>{parsedContent}</p>
}

// Image message
function renderImageContent(content: {
  url?: string
  height?: number
  width?: number
  size?: number
}): React.ReactNode {
  if (!content.url) {
    return (
      <div className='flex items-center gap-2 text-muted-foreground'>
        <ImageIcon className='size-4' />
        <span className='text-sm'>[图片]</span>
      </div>
    )
  }

  // Ensure HTTPS for the image URL
  const imageUrl = enforceHttps(content.url)

  // Calculate display dimensions (max 300px width)
  const maxWidth = 300
  const aspectRatio = content.width && content.height ? content.width / content.height : 1
  const displayWidth = Math.min(content.width || maxWidth, maxWidth)
  const displayHeight = displayWidth / aspectRatio

  return (
    <a href={imageUrl} target='_blank' rel='noopener noreferrer' className='block'>
      <picture>
        <img
          src={imageUrl}
          alt='图片消息'
          className='rounded-lg'
          style={{
            maxWidth: `${displayWidth}px`,
            maxHeight: `${displayHeight}px`,
            width: 'auto',
            height: 'auto',
          }}
          loading='lazy'
          referrerPolicy='no-referrer'
        />
      </picture>
    </a>
  )
}

// Custom emoji (sticker)
function renderCustomEmojiContent(content: { url?: string; width?: number; height?: number }): React.ReactNode {
  if (!content.url) {
    return <span className='text-sm'>[表情]</span>
  }

  // Ensure HTTPS for the emoji URL
  const emojiUrl = enforceHttps(content.url)

  return (
    <picture>
      <img
        src={emojiUrl}
        alt='表情'
        className='max-h-32 max-w-32'
        style={{
          width: content.width ? Math.min(content.width, 128) : 'auto',
          height: content.height ? Math.min(content.height, 128) : 'auto',
        }}
        loading='lazy'
        referrerPolicy='no-referrer'
      />
    </picture>
  )
}

// Revoked message
function renderRevokeContent(): React.ReactNode {
  return <p className='text-sm italic'>[已撤回的消息]</p>
}

// Notification message
function renderNotificationContent(content: {
  title?: unknown
  text?: unknown
  jump_uri?: string
  jump_text?: string
  jump_uri_config?: { all_uri?: string; text?: string }
  modules?: Array<{ title?: string; detail?: string }>
}): React.ReactNode {
  const jumpUrl = content.jump_uri_config?.all_uri || content.jump_uri
  const title = extractTextContent(content.title)
  const text = extractTextContent(content.text)
  const modules = content.modules

  return (
    <div className='space-y-3'>
      {/* Header */}
      {title && <p className='font-semibold'>{title}</p>}

      {/* Description text */}
      {text && <p className='text-muted-foreground text-sm'>{text}</p>}

      {/* Modules list */}
      {modules && modules.length > 0 && (
        <div className='space-y-1.5'>
          {modules.map((module, index) => (
            <div key={`${index}-${module.title}`} className='flex gap-4 text-sm'>
              <span className='w-24 shrink-0 text-muted-foreground'>{module.title}</span>
              <span>{module.detail}</span>
            </div>
          ))}
        </div>
      )}

      {/* Action link */}
      {jumpUrl && (
        <div>
          <Separator />
          <a
            href={jumpUrl}
            target='_blank'
            rel='noopener noreferrer'
            className='-mx-3 -mb-2 flex items-center justify-between px-3 py-2 text-sm'
          >
            <span>{content.jump_text || content.jump_uri_config?.text || '查看详情'}</span>
            <ChevronRight className='size-4 text-muted-foreground' />
          </a>
        </div>
      )}
    </div>
  )
}

// Video push message
function renderVideoPushContent(content: {
  title?: unknown
  desc?: unknown
  cover?: string
  bvid?: string
  rid?: number
  view?: number
  danmaku?: number
  pub_date?: number
  attach_msg?: unknown
}): React.ReactNode {
  const videoUrl = content.bvid
    ? `https://www.bilibili.com/video/${content.bvid}`
    : content.rid
      ? `https://www.bilibili.com/video/av${content.rid}`
      : null

  const title = extractTextContent(content.title)
  const desc = extractTextContent(content.desc)
  const attachMsg = extractTextContent(content.attach_msg)

  // Format publish date
  const pubDate = content.pub_date
    ? new Date(content.pub_date * 1000).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      })
    : null

  // Ensure HTTPS for the cover image
  const coverUrl = enforceHttps(content.cover)

  return (
    <div className='w-72 overflow-hidden rounded-lg border border-border/50 bg-white transition-colors dark:bg-zinc-800'>
      <a
        href={videoUrl || '#'}
        target='_blank'
        rel='noopener noreferrer'
        className='flex gap-3 p-3 hover:bg-zinc-50 dark:hover:bg-zinc-700/50'
      >
        {coverUrl && (
          <div className='relative size-20 flex-none overflow-hidden rounded-lg'>
            <picture>
              <img
                src={coverUrl}
                alt={title || '视频'}
                className='size-full object-cover'
                loading='lazy'
                referrerPolicy='no-referrer'
              />
            </picture>
          </div>
        )}
        <div className='flex min-w-0 flex-1 flex-col justify-center gap-1'>
          <p className='line-clamp-2 font-medium text-sm leading-snug'>{title || desc || '视频'}</p>
          <div className='flex items-center gap-2 text-muted-foreground text-xs'>
            {pubDate && <span>{pubDate}</span>}
            {content.danmaku !== undefined && (
              <span className='flex items-center gap-0.5'>
                <MessageSquareText className='size-3' />
                {content.danmaku}
              </span>
            )}
          </div>
        </div>
      </a>
      {attachMsg && (
        <div className='border-border/50 border-t px-3 py-2'>
          <p className='text-muted-foreground text-xs'>
            <span className='font-medium text-foreground'>UP主赠言：</span> {attachMsg}
          </p>
        </div>
      )}
    </div>
  )
}

// Share message (various types)
function renderShareContent(content: {
  title?: unknown
  source?: unknown
  desc?: unknown
  cover?: string
  url?: string
  sketch?: {
    title?: unknown
    desc_text?: unknown
    cover_url?: string
    target_url?: string
  }
}): React.ReactNode {
  const sketch = content.sketch
  const title = extractTextContent(sketch?.title) || extractTextContent(content.title)
  const desc = extractTextContent(sketch?.desc_text) || extractTextContent(content.desc)
  const source = extractTextContent(content.source)
  const cover = sketch?.cover_url || content.cover
  const url = sketch?.target_url || content.url

  // Ensure HTTPS for the cover image
  const coverUrl = enforceHttps(cover)

  return (
    <a
      href={url || '#'}
      target='_blank'
      rel='noopener noreferrer'
      className='block overflow-hidden rounded-lg border border-border/50 bg-zinc-50 transition-colors hover:bg-zinc-100 dark:bg-zinc-800/50 dark:hover:bg-zinc-800'
    >
      {coverUrl && (
        <div className='aspect-video w-48'>
          <picture>
            <img
              src={coverUrl}
              alt={title || '分享'}
              className='size-full object-cover'
              loading='lazy'
              referrerPolicy='no-referrer'
            />
          </picture>
        </div>
      )}
      <div className='space-y-0.5 p-2'>
        {source && <p className='text-muted-foreground text-xs'>{source}</p>}
        <p className='line-clamp-2 font-medium text-sm'>{title || '分享内容'}</p>
        {desc && <p className='line-clamp-2 text-muted-foreground text-xs'>{desc}</p>}
      </div>
    </a>
  )
}

// Fan group system message
function renderFanGroupSystemContent(content: { content?: unknown; group_id?: number }): React.ReactNode {
  const text = extractTextContent(content.content) || extractTextContent(content)
  return <p className='text-sm italic'>{text || '[粉丝团系统消息]'}</p>
}

// System tip message (msg_type 18)
// Content format: { content: "[{\"text\":\"...\", \"color_day\":\"#9499A0\", \"color_nig\":\"#9499A0\"}]" }
// The inner content is a serialized JSON string that needs to be parsed
function renderSystemTipContent(content: { content?: string }): React.ReactNode {
  try {
    // The content.content field is a serialized JSON array string
    const tipItems: Array<{ text?: string; color_day?: string; color_nig?: string; jump_url?: string }> =
      typeof content.content === 'string' ? JSON.parse(content.content) : []

    if (!Array.isArray(tipItems) || tipItems.length === 0) {
      return <p className='text-center text-muted-foreground text-xs'>[系统提示]</p>
    }

    return (
      <p className='text-center text-xs'>
        {tipItems.map((item, index) => {
          const key = `${index}-${item.text?.slice(0, 10)}`
          const dayColor = item.color_day || '#9499A0'
          const nightColor = item.color_nig || '#9499A0'
          const textContent = item.text || ''

          // Use two spans to handle light/dark mode colors since inline styles
          // have higher specificity than class-based dark: modifiers
          const textElement = (
            <span key={key}>
              <span className='dark:hidden' style={{ color: dayColor }}>
                {textContent}
              </span>
              <span className='hidden dark:inline' style={{ color: nightColor }}>
                {textContent}
              </span>
            </span>
          )

          // Wrap with link if jump_url is provided
          if (item.jump_url) {
            return (
              <a key={key} href={item.jump_url} target='_blank' rel='noopener noreferrer' className='hover:underline'>
                {textElement}
              </a>
            )
          }

          return textElement
        })}
      </p>
    )
  } catch {
    // Fallback if parsing fails
    const text = extractTextContent(content)
    return <p className='text-center text-muted-foreground text-xs'>{text || '[系统提示]'}</p>
  }
}

// Default fallback for unknown types
function renderDefaultContent(content: Record<string, unknown>, msgType: number): React.ReactNode {
  // Try to extract readable text from content using safe extraction
  const text = extractTextContent(content)

  if (text) {
    return <p className='wrap-break-word whitespace-break-spaces break-all text-sm leading-relaxed'>{text}</p>
  }

  return <p className='text-sm'>[消息类型 {msgType}]</p>
}

// Message inspector popover component
function MessageInspector({ message, emojiInfoMap }: { message: BilibiliMessage; emojiInfoMap: EmojiInfoMap }) {
  // Get relevant emoji info for this message by checking if any emoji codes appear in the content
  const relevantEmojiInfo: Record<string, (typeof emojiInfoMap)[string]> = {}
  if (message.content) {
    for (const [emojiCode, info] of Object.entries(emojiInfoMap)) {
      if (message.content.includes(emojiCode)) {
        relevantEmojiInfo[emojiCode] = info
      }
    }
  }
  const hasEmojiInfo = Object.keys(relevantEmojiInfo).length > 0

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant='ghost' size='icon-xs'>
            <Code />
          </Button>
        }
      />
      <PopoverPopup side='top' align='start' className='w-96'>
        <PopoverTitle className='mb-2 text-sm'>消息源</PopoverTitle>
        <div className='space-y-2 text-xs'>
          <div className='grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground'>
            <span>msg_type:</span>
            <span className='font-mono text-foreground'>{message.msg_type}</span>
            <span>msg_source:</span>
            <span className='font-mono text-foreground'>{message.msg_source}</span>
            <span>msg_key:</span>
            <span className='font-mono text-foreground'>{message.msg_key}</span>
            <span>msg_status:</span>
            <span className='font-mono text-foreground'>{message.msg_status}</span>
            <span>timestamp:</span>
            <span className='font-mono text-foreground'>{message.timestamp}</span>
          </div>
          <Separator />
          <div>
            <span className='text-muted-foreground'>message:</span>
            <pre className='mt-1 max-h-48 overflow-auto rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-800'>
              {JSON.stringify(message, null, 2)}
            </pre>
          </div>
          {hasEmojiInfo && (
            <div>
              <span className='text-muted-foreground'>e_infos (relevant):</span>
              <pre className='mt-1 max-h-48 overflow-auto rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-800'>
                {JSON.stringify(relevantEmojiInfo, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  )
}

// Check if a message can be recalled (within 120 seconds)
function canRecallMessage(message: BilibiliMessage, isSent: boolean): boolean {
  if (!isSent) return false
  if (message.msg_status !== 0) return false // Already recalled or invalid

  const now = Math.floor(Date.now() / 1000)
  const messageAge = now - message.timestamp
  return messageAge <= 120 // 120 seconds = 2 minutes
}

export function MessageBubble({
  message,
  emojiInfoMap,
  isSent,
  session,
  userCache,
  userInfo,
  onRecall,
}: MessageBubbleProps) {
  const sourceLabel = getMessageSourceLabel(message.msg_source)
  const isAutoReply = isAutoReplySource(message.msg_source)
  const isRecallable = canRecallMessage(message, isSent)

  const handleRecall = async () => {
    if (onRecall && message.msg_key) {
      // Pass msg_seqno for local state update and msg_key as string for API
      // Using String() to preserve the full integer value (avoids JavaScript number precision loss)
      const result = await onRecall(message.msg_seqno, String(message.msg_key))

      if (!result.success) {
        // Show error toast when recall fails
        toastManager.add({
          type: 'error',
          title: '撤回失败',
          description: result.error || '无法撤回该消息',
        })
      }
    }
  }

  // System tip messages (msg_type 18) should be displayed centered without bubble styling
  if (message.msg_type === MSG_TYPE.SYSTEM_TIP) {
    return (
      <div className='flex justify-center py-1'>
        <div className='rounded-full bg-zinc-100 px-3 py-1 dark:bg-zinc-800/50'>
          {renderMessageContent(message, emojiInfoMap)}
        </div>
      </div>
    )
  }

  // Rich content types that need different styling
  const RICH_CONTENT_TYPES: number[] = [MSG_TYPE.IMAGE, MSG_TYPE.CUSTOM_EMOJI, MSG_TYPE.VIDEO_PUSH, MSG_TYPE.SHARE]
  const isRichContent = RICH_CONTENT_TYPES.includes(message.msg_type)

  // Get avatar URL based on sender
  const avatarUrl = isSent
    ? userInfo?.face // Current user's avatar for sent messages
    : getSessionAvatar(session, userCache) // Other user's avatar for received messages

  const isFanGroup = session.session_type === SESSION_TYPE.FAN_GROUP

  // Get the user ID for the Bilibili space link
  const resolvedUid = isSent ? userInfo?.mid : session.talker_id
  const bilibiliSpaceUrl = resolvedUid ? `https://space.bilibili.com/${resolvedUid}` : null

  return (
    <div className={`flex gap-3 ${isSent ? 'flex-row-reverse' : ''}`}>
      <Menu>
        <MenuTrigger
          nativeButton={false}
          render={
            <Avatar className='size-8 flex-none cursor-pointer ring-1 ring-border/50 transition-opacity hover:opacity-80'>
              {avatarUrl && <AvatarImage src={enforceHttps(avatarUrl)} referrerPolicy='no-referrer' />}
              <AvatarFallback
                className={
                  isSent
                    ? 'bg-linear-to-br from-blue-400 to-cyan-300 text-white'
                    : 'bg-linear-to-br from-pink-400 to-orange-300 text-white'
                }
              >
                {isFanGroup && !isSent ? <Users className='size-3.5' /> : <User className='size-3.5' />}
              </AvatarFallback>
            </Avatar>
          }
        />
        <MenuPopup side={'bottom'} align={isSent ? 'end' : 'start'}>
          {bilibiliSpaceUrl && (
            <a href={bilibiliSpaceUrl} target='_blank' rel='noopener noreferrer'>
              <MenuItem>
                <ExternalLink />
                个人空间
              </MenuItem>
            </a>
          )}
          {isRecallable && onRecall && (
            <MenuItem onClick={handleRecall}>
              <Undo2 />
              撤回
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>

      <div className={`flex max-w-[70%] flex-col gap-1 ${isSent ? 'items-end' : ''}`}>
        <div
          className={cn(
            'rounded-2xl',
            isRichContent
              ? 'overflow-hidden'
              : [
                  'px-4 py-2.5',
                  isSent
                    ? 'bg-linear-to-br from-pink-500 to-rose-500 text-white'
                    : 'bg-white shadow-sm dark:bg-zinc-800',
                ],
            message.msg_status === 1 && 'opacity-50'
          )}
        >
          {renderMessageContent(message, emojiInfoMap)}
        </div>
        <div className={`flex items-center gap-1.5 ${isSent ? 'flex-row-reverse' : ''}`}>
          <Tooltip>
            <TooltipTrigger className='cursor-default px-1 text-muted-foreground text-xs'>
              {formatTime(message.timestamp)}
            </TooltipTrigger>
            <TooltipPopup>{formatAbsoluteTime(message.timestamp)}</TooltipPopup>
          </Tooltip>
          {sourceLabel && (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                isAutoReply
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
              }`}
            >
              {isAutoReply && <Bot className='size-3' />}
              {sourceLabel}
            </span>
          )}
          <MessageInspector message={message} emojiInfoMap={emojiInfoMap} />
        </div>
      </div>
    </div>
  )
}
