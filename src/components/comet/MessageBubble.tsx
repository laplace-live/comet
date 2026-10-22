import {
  Bot,
  ChevronRight,
  Code,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  MessageSquareText,
  Undo2,
  User,
  Users,
  Video,
} from 'lucide-react'
import { useState } from 'react'

import type { EmojiInfoMap } from '@/hooks/usePrivateMessages'
import type { CustomerServiceContent, CustomerServiceLink, CustomerServiceReply } from '@/lib/customer-service'
import type { UserCache } from '@/lib/message-utils'
import type { BilibiliMessage, BilibiliSession } from '@/types/bilibili'
import type { CheckLoginResult } from '@/types/electron'

import { MSG_SOURCE, MSG_TYPE, SESSION_TYPE } from '@/types/bilibili'

import { getCustomerServicePreview, parseCustomerServiceContent } from '@/lib/customer-service'
import { formatTime, getSessionAvatar } from '@/lib/message-utils'
import { cn } from '@/lib/utils'

import { enforceHttps } from '@/utils/enforceHttps'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu'
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { toastManager } from '@/components/ui/toast'

import { useSettings } from '@/stores/useSettings'
import { TimeTooltip } from './TimeTooltip'

interface MessageBubbleProps {
  message: BilibiliMessage
  emojiInfoMap: EmojiInfoMap
  isSent: boolean
  session: BilibiliSession
  userCache: UserCache
  userInfo: CheckLoginResult | null
  onRecall?: (msgSeqno: number, msgKeyStr: string) => Promise<{ success: boolean; error?: string }>
  /** Sends what picking one of a customer service bot's suggestions sends */
  onCustomerServiceReply?: (reply: CustomerServiceReply) => Promise<boolean>
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
      return '回音AI'
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

      case MSG_TYPE.AI_GENERATED:
        return renderAiGeneratedContent(content)

      default:
        return renderDefaultContent(content, message.msg_type)
    }
  } catch {
    // If content is not JSON, render as plain text
    return (
      <p className='text-sm leading-relaxed wrap-break-word whitespace-break-spaces'>
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
    return <p className='text-sm leading-relaxed wrap-break-word break-all whitespace-break-spaces'>[空消息]</p>
  }

  const parsedContent = parseTextWithEmojis(text, emojiInfoMap)

  return <p className='text-sm leading-relaxed wrap-break-word break-all whitespace-break-spaces'>{parsedContent}</p>
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

  // Calculate display dimensions (max 300px width, maintain aspect ratio)
  const maxWidth = 300
  const originalWidth = content.width || 0
  const originalHeight = content.height || 0
  const displayWidth = originalWidth > 0 ? Math.min(originalWidth, maxWidth) : maxWidth

  // Calculate display height based on aspect ratio if both dimensions are available
  const displayHeight = originalWidth > 0 && originalHeight > 0 ? (displayWidth / originalWidth) * originalHeight : null

  return (
    <a href={imageUrl} target='_blank' rel='noopener noreferrer' className='block'>
      <picture>
        <img
          src={imageUrl}
          alt='图片消息'
          className='max-w-full rounded-lg'
          style={{
            width: `${displayWidth}px`,
            height: displayHeight ? `${displayHeight}px` : 'auto',
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
      {text && <p className='text-sm text-muted-foreground'>{text}</p>}

      {/* Modules list */}
      {modules && modules.length > 0 && (
        <div className='space-y-1.5'>
          {modules.map(module => (
            <div key={`${module.title}-${module.detail}`} className='flex gap-4 text-sm'>
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
          <p className='line-clamp-2 text-sm leading-snug font-medium'>{title || desc || '视频'}</p>
          <div className='flex items-center gap-2 text-xs text-muted-foreground'>
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
        <div className='border-t border-border/50 px-3 py-2'>
          <p className='text-xs text-muted-foreground'>
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
        {source && <p className='text-xs text-muted-foreground'>{source}</p>}
        <p className='line-clamp-2 text-sm font-medium'>{title || '分享内容'}</p>
        {desc && <p className='line-clamp-2 text-xs text-muted-foreground'>{desc}</p>}
      </div>
    </a>
  )
}

// Fan group system message
function renderFanGroupSystemContent(content: { content?: unknown; group_id?: number }): React.ReactNode {
  const text = extractTextContent(content.content) || extractTextContent(content)
  return <span>{text || '[粉丝团系统消息]'}</span>
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
      return <p className='text-center text-xs text-muted-foreground'>[系统提示]</p>
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
    return <p className='text-center text-xs text-muted-foreground'>{text || '[系统提示]'}</p>
  }
}

// AI generated message (msg_type 52)
// Content format: { paragraphs: [{ para_type: 1, text: { nodes: [{ node_type: 1, raw_text: "...", word: {...} }] } }], sub_type: 4, ... }
// sub_type 4 = system-like welcome message (centered display)
// Other sub_types = normal chat messages (bubble display)
function renderAiGeneratedContent(content: {
  paragraphs?: Array<{
    para_type?: number
    text?: {
      nodes?: Array<{
        node_type?: number
        raw_text?: string
        word?: { words?: string; font_size?: number }
      }>
    }
  }>
  sub_type?: number
}): React.ReactNode {
  try {
    const paragraphs = content.paragraphs || []
    const isSystemLike = content.sub_type === 4

    if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
      return isSystemLike ? (
        <p className='text-center text-xs text-muted-foreground'>[AI 消息]</p>
      ) : (
        <p className='text-sm leading-relaxed wrap-break-word break-all whitespace-break-spaces'>[AI 消息]</p>
      )
    }

    // Extract text from all paragraphs
    // Nodes within a paragraph are word-level inline elements that should be concatenated together
    // Only paragraph breaks should use newlines
    const paragraphTexts: string[] = []
    for (const paragraph of paragraphs) {
      const nodes = paragraph.text?.nodes || []
      const nodeTexts: string[] = []
      for (const node of nodes) {
        // Prefer raw_text, fallback to word.words
        const text = node.raw_text || node.word?.words
        if (text) {
          nodeTexts.push(text)
        }
      }
      // Join nodes within a paragraph without separator (they're inline elements)
      const paragraphText = nodeTexts.join('')
      if (paragraphText) {
        paragraphTexts.push(paragraphText)
      }
    }

    // Join paragraphs with newlines
    const fullText = paragraphTexts.join('\n')

    if (!fullText) {
      return isSystemLike ? (
        <p className='text-center text-xs text-muted-foreground'>[AI 消息]</p>
      ) : (
        <p className='text-sm leading-relaxed wrap-break-word break-all whitespace-break-spaces'>[AI 消息]</p>
      )
    }

    // System-like messages (sub_type 4) are left-aligned with muted styling
    if (isSystemLike) {
      return (
        <p className='text-xs whitespace-pre-wrap'>
          <span className='text-muted-foreground'>{fullText}</span>
        </p>
      )
    }

    // Normal AI chat messages use regular text styling
    return <p className='text-sm leading-relaxed wrap-break-word break-all whitespace-break-spaces'>{fullText}</p>
  } catch {
    return <p className='text-center text-xs text-muted-foreground'>[AI 消息]</p>
  }
}

// Default fallback for unknown types
function renderDefaultContent(content: Record<string, unknown>, msgType: number): React.ReactNode {
  // Try to extract readable text from content using safe extraction
  const text = extractTextContent(content)

  if (text) {
    return <p className='text-sm leading-relaxed wrap-break-word break-all whitespace-break-spaces'>{text}</p>
  }

  return <p className='text-sm'>[消息类型 {msgType}]</p>
}

// Link inside a customer service message (details, leaving a message, more questions)
function renderCustomerServiceLink(link: CustomerServiceLink): React.ReactNode {
  return (
    <a
      href={link.url}
      target='_blank'
      rel='noopener noreferrer'
      className='inline-flex items-center gap-1 text-sm text-sky-600 hover:underline dark:text-sky-400'
    >
      {link.text}
      <ExternalLink className='size-3.5' aria-hidden='true' />
    </a>
  )
}

// Customer service video: an uploaded clip or a video card
function renderCustomerServiceVideo(content: { title?: string; cover?: string; url?: string }): React.ReactNode {
  const coverUrl = enforceHttps(content.cover)
  const card = (
    <div className='w-60 overflow-hidden rounded-lg border border-border/50 bg-white dark:bg-zinc-800'>
      {coverUrl && (
        <picture>
          <img
            src={coverUrl}
            alt={content.title || '视频'}
            className='aspect-video w-full object-cover'
            loading='lazy'
            referrerPolicy='no-referrer'
          />
        </picture>
      )}
      <p className='flex items-center gap-1.5 p-2 text-sm'>
        <Video className='size-4 flex-none text-muted-foreground' aria-hidden='true' />
        <span className='line-clamp-2'>{content.title || '[视频]'}</span>
      </p>
    </div>
  )

  return content.url ? (
    <a href={enforceHttps(content.url)} target='_blank' rel='noopener noreferrer' className='block'>
      {card}
    </a>
  ) : (
    card
  )
}

// One-time choices picked from here, by the msg_key of the message offering them. The list unmounts a
// bubble once it scrolls away, so this outlives it until the server's copy of the message says so too.
const pickedCustomerServiceChoices = new Map<string, number>()

// The bot's suggestions as buttons: picking one sends its reply, and one-time choices lock once picked
function CustomerServiceChoices({
  content,
  messageKey,
  onReply,
}: {
  content: Extract<CustomerServiceContent, { kind: 'choices' }>
  messageKey: string
  onReply?: (reply: CustomerServiceReply) => Promise<boolean>
}) {
  const [sending, setSending] = useState(false)
  // Picked here, before the server's copy of the message says so
  const [pickedHere, setPickedHere] = useState(() => pickedCustomerServiceChoices.get(messageKey) ?? null)
  const done = !!content.once && (content.once.done || pickedHere !== null)

  const pick = async (index: number) => {
    if (!onReply || sending || done) return
    setSending(true)
    const sent = await onReply(content.choices[index].reply)
    setSending(false)
    if (sent && content.once) {
      pickedCustomerServiceChoices.set(messageKey, index)
      setPickedHere(index)
    }
  }

  return (
    <div className='space-y-2'>
      <p className='text-sm leading-relaxed wrap-break-word break-all whitespace-break-spaces'>{content.text}</p>
      {content.choices.length > 0 && (
        <div className='flex flex-col gap-1'>
          {content.choices.map((choice, index) => {
            const picked = choice.picked || pickedHere === index
            return (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: choices can repeat and never reorder
                key={`${index}-${choice.text}`}
                type='button'
                disabled={!onReply || sending || done}
                onClick={() => pick(index)}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-md bg-zinc-100 px-2.5 py-1.5 text-left text-sm transition-colors dark:bg-zinc-700/60',
                  'enabled:cursor-pointer enabled:hover:bg-zinc-200 dark:enabled:hover:bg-zinc-700',
                  done && !picked && 'opacity-60',
                  picked && 'text-sky-600 dark:text-sky-400'
                )}
              >
                <span className='min-w-0'>{choice.text}</span>
                {onReply && !done && (
                  <ChevronRight className='size-4 flex-none text-muted-foreground' aria-hidden='true' />
                )}
              </button>
            )
          })}
        </div>
      )}
      {content.link && renderCustomerServiceLink(content.link)}
    </div>
  )
}

// Customer service message, in one of the shapes lib/customer-service parses it into
function renderCustomerServiceContent(
  content: CustomerServiceContent,
  emojiInfoMap: EmojiInfoMap,
  onReply?: (reply: CustomerServiceReply) => Promise<boolean>,
  messageKey = ''
): React.ReactNode {
  switch (content.kind) {
    case 'text':
      return (
        <div className='space-y-2'>
          <p className='text-sm leading-relaxed wrap-break-word break-all whitespace-break-spaces'>
            {parseTextWithEmojis(content.text, emojiInfoMap)}
          </p>
          {content.image && renderImageContent({ url: content.image })}
          {content.link && renderCustomerServiceLink(content.link)}
        </div>
      )

    case 'choices':
      // Keyed, since the list can put another message where this one was
      return <CustomerServiceChoices key={messageKey} content={content} messageKey={messageKey} onReply={onReply} />

    case 'image':
      return renderImageContent(content)

    case 'video':
      return renderCustomerServiceVideo(content)

    case 'card':
      return (
        <div className='space-y-2'>
          <p className='text-sm font-medium'>{content.title}</p>
          {content.details.length > 0 && (
            <div className='space-y-1'>
              {content.details.map(detail => (
                <div key={detail.label} className='flex gap-3 text-xs'>
                  <span className='w-14 flex-none text-muted-foreground'>{detail.label}</span>
                  <span className='min-w-0 break-all'>{detail.value}</span>
                </div>
              ))}
            </div>
          )}
          {content.link && renderCustomerServiceLink(content.link)}
        </div>
      )

    case 'notice':
      return (
        <span>
          {content.text}
          {content.link && <> {renderCustomerServiceLink(content.link)}</>}
        </span>
      )

    case 'hidden':
      return null
  }
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
          <Button variant='ghost' size='icon-xs' aria-label='查看消息源'>
            <Code aria-hidden='true' />
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
  onCustomerServiceReply,
}: MessageBubbleProps) {
  const { developerMode } = useSettings()
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

  // Get copyable text from the message content
  const getCopyableText = (): string => {
    if (message.customer_service_sender) return getCustomerServicePreview(message)
    try {
      const content = JSON.parse(message.content)
      return extractTextContent(content.content) || extractTextContent(content) || message.content
    } catch {
      return message.content || ''
    }
  }

  // Get image URL from image message content
  const getImageUrl = (): string | null => {
    if (message.msg_type !== MSG_TYPE.IMAGE) return null
    try {
      const content = JSON.parse(message.content)
      return content.url ? enforceHttps(content.url) : null
    } catch {
      return null
    }
  }

  const handleCopy = async () => {
    // Handle image messages - copy the image itself using Electron's clipboard API
    if (message.msg_type === MSG_TYPE.IMAGE) {
      const imageUrl = getImageUrl()
      if (imageUrl) {
        try {
          // Use Electron's native clipboard API to copy image (bypasses CORS)
          const result = await window.electronAPI.clipboard.copyImage({ imageUrl })
          if (result.success) {
            toastManager.add({
              type: 'success',
              title: '已复制图片',
            })
          } else {
            // Fallback: copy the image URL if image copy fails
            await navigator.clipboard.writeText(imageUrl)
            toastManager.add({
              type: 'success',
              title: '已复制图片链接',
            })
          }
          return
        } catch {
          // Fallback: copy the image URL if image copy fails
          await navigator.clipboard.writeText(imageUrl)
          toastManager.add({
            type: 'success',
            title: '已复制图片链接',
          })
          return
        }
      }
    }

    // Handle text messages
    const text = getCopyableText()
    if (text) {
      try {
        await navigator.clipboard.writeText(text)
        toastManager.add({
          type: 'success',
          title: '已复制',
        })
      } catch {
        toastManager.add({
          type: 'error',
          title: '复制失败',
        })
      }
    }
  }

  // Revoke command messages (msg_type 5) should be hidden - they're technical messages to trigger recall
  // In developer mode, show these as system-like messages for debugging
  if (message.msg_type === MSG_TYPE.REVOKE) {
    if (!developerMode) {
      return null
    }
    // Show revoke event in developer mode
    return (
      <div className='flex items-center justify-center gap-1 py-1'>
        <div className='flex items-center gap-2 rounded-full border border-dashed border-amber-500/50 bg-amber-50 px-3 py-1 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-400'>
          <Code className='size-3' aria-hidden='true' />
          <span>撤回事件 (msg_type: {MSG_TYPE.REVOKE})</span>
        </div>
        <MessageInspector message={message} emojiInfoMap={emojiInfoMap} />
      </div>
    )
  }

  // Customer service messages have types of their own; notices (queue state, a closed session) are centered.
  // As in the web client, the content alone decides: what Bilibili's system sends can carry links and choices.
  const customerServiceContent = message.customer_service_sender ? parseCustomerServiceContent(message) : null
  if (customerServiceContent?.kind === 'notice') {
    return (
      <div className='flex items-center justify-center gap-1 py-1'>
        <div className='rounded-full bg-zinc-100 px-3 py-1 text-center text-xs text-muted-foreground dark:bg-zinc-800/50'>
          {renderCustomerServiceContent(customerServiceContent, emojiInfoMap)}
        </div>
        {developerMode && <MessageInspector message={message} emojiInfoMap={emojiInfoMap} />}
      </div>
    )
  }

  // System tip messages (msg_type 18) should be displayed centered without bubble styling
  // Fan group system messages (msg_type 306, e.g. "欢迎xxx入群") should be displayed centered
  if (message.msg_type === MSG_TYPE.SYSTEM_TIP || message.msg_type === MSG_TYPE.FAN_GROUP_SYSTEM) {
    return (
      <div className='flex items-center justify-center gap-1 py-1'>
        <div className='rounded-full bg-zinc-100 px-3 py-1 text-xs text-muted-foreground dark:bg-zinc-800/50'>
          {renderMessageContent(message, emojiInfoMap)}
        </div>
        {developerMode && <MessageInspector message={message} emojiInfoMap={emojiInfoMap} />}
      </div>
    )
  }

  // AI generated messages (msg_type 52) - sub_type 4 is system-like welcome message (centered)
  // Other sub_types are normal chat messages and fall through to regular bubble rendering
  if (message.msg_type === MSG_TYPE.AI_GENERATED) {
    try {
      const aiContent = JSON.parse(message.content)
      // sub_type 4 = system-like welcome/announcement message
      if (aiContent.sub_type === 4) {
        return (
          <div className='flex items-center justify-center gap-1 py-1'>
            <div className='rounded bg-zinc-100 px-3 py-1 dark:bg-zinc-800/50'>
              {renderMessageContent(message, emojiInfoMap)}
            </div>
            {developerMode && <MessageInspector message={message} emojiInfoMap={emojiInfoMap} />}
          </div>
        )
      }
      // Other sub_types fall through to normal message rendering below
    } catch {
      // If parsing fails, display as centered fallback
      return (
        <div className='flex items-center justify-center gap-1 py-1'>
          <div className='rounded-full bg-zinc-100 px-3 py-1 dark:bg-zinc-800/50'>
            {renderMessageContent(message, emojiInfoMap)}
          </div>
          {developerMode && <MessageInspector message={message} emojiInfoMap={emojiInfoMap} />}
        </div>
      )
    }
  }

  // Recalled/revoked messages (msg_status === 1) should be displayed centered like system messages
  // In developer mode, show the original content with a visual indicator
  if (message.msg_status === 1 && !developerMode) {
    return (
      <div className='flex justify-center py-1'>
        <div className='rounded-full bg-zinc-100 px-3 py-1 text-xs text-muted-foreground dark:bg-zinc-800/50'>
          {isSent ? '你撤回了一条消息' : '对方撤回了一条消息'}
        </div>
      </div>
    )
  }

  // In developer mode, mark recalled messages but show their content
  const isRecalledInDevMode = message.msg_status === 1 && developerMode

  // Rich content types that need different styling
  const RICH_CONTENT_TYPES: number[] = [MSG_TYPE.IMAGE, MSG_TYPE.CUSTOM_EMOJI, MSG_TYPE.VIDEO_PUSH, MSG_TYPE.SHARE]
  const isRichContent = customerServiceContent
    ? customerServiceContent.kind === 'image' || customerServiceContent.kind === 'video'
    : RICH_CONTENT_TYPES.includes(message.msg_type)

  const isFanGroup = session.session_type === SESSION_TYPE.FAN_GROUP

  // Avatar, name (shown above messages from others) and Bilibili space of whoever sent the message.
  // Group chats use the actual sender from userCache, not the group; customer service senders have no space
  const senderInfo = userCache[message.sender_uid]
  const customerServiceSender = message.customer_service_sender
  const sender = isSent
    ? { face: userInfo?.face, name: null, uid: userInfo?.mid }
    : customerServiceSender
      ? { face: customerServiceSender.face, name: customerServiceSender.name, uid: null }
      : isFanGroup
        ? { face: senderInfo?.face, name: senderInfo?.name || `UID:${message.sender_uid}`, uid: message.sender_uid }
        : { face: getSessionAvatar(session, userCache), name: null, uid: session.talker_id }
  const { face: avatarUrl, name: senderName, uid: resolvedUid } = sender
  const bilibiliSpaceUrl = resolvedUid ? `https://space.bilibili.com/${resolvedUid}` : null
  const laplaceUrl = resolvedUid ? `https://laplace.live/user/${resolvedUid}` : null
  const hasUserMenu = !!bilibiliSpaceUrl || (isRecallable && !!onRecall)

  const avatar = (
    <Avatar
      className={cn(
        'size-8 flex-none ring-1 ring-border/50',
        hasUserMenu && 'cursor-pointer transition-opacity hover:opacity-80'
      )}
    >
      {avatarUrl && <AvatarImage src={enforceHttps(avatarUrl)} referrerPolicy='no-referrer' />}
      <AvatarFallback
        className={
          isSent
            ? 'bg-linear-to-br from-blue-400 to-cyan-300 text-white'
            : 'bg-linear-to-br from-pink-400 to-orange-300 text-white'
        }
      >
        {isFanGroup && !isSent ? (
          <Users className='size-3.5' aria-hidden='true' />
        ) : (
          <User className='size-3.5' aria-hidden='true' />
        )}
      </AvatarFallback>
    </Avatar>
  )

  return (
    <div className={`flex gap-3 ${isSent ? 'flex-row-reverse' : ''}`}>
      {hasUserMenu ? (
        <Menu>
          <MenuTrigger nativeButton={false} aria-label='用户菜单' render={avatar} />
          <MenuPopup side={'bottom'} align={isSent ? 'end' : 'start'}>
            {bilibiliSpaceUrl && (
              <a href={bilibiliSpaceUrl} target='_blank' rel='noopener noreferrer'>
                <MenuItem>
                  <ExternalLink aria-hidden='true' />
                  个人空间
                </MenuItem>
              </a>
            )}
            {laplaceUrl && (
              <a href={laplaceUrl} target='_blank' rel='noopener noreferrer'>
                <MenuItem>
                  <ExternalLink aria-hidden='true' />
                  LAPLACE Live!
                </MenuItem>
              </a>
            )}
            {isRecallable && onRecall && (
              <MenuItem onClick={handleRecall}>
                <Undo2 aria-hidden='true' />
                撤回
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
      ) : (
        avatar
      )}

      <div className={cn('flex max-w-[70%] flex-col gap-1', isSent ? 'items-end' : 'items-start')}>
        {/* Sender name for group chats and customer service (shown for received messages) */}
        {senderName &&
          (bilibiliSpaceUrl ? (
            <a
              href={bilibiliSpaceUrl}
              target='_blank'
              rel='noopener noreferrer'
              className='truncate text-xs text-muted-foreground hover:text-foreground hover:underline'
            >
              {senderName}
            </a>
          ) : (
            <span className='truncate text-xs text-muted-foreground'>{senderName}</span>
          ))}
        {/* Developer mode indicator for recalled messages */}
        {isRecalledInDevMode && (
          <div className='flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400'>
            <Undo2 className='size-3' aria-hidden='true' />
            <span>已撤回</span>
          </div>
        )}
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                className={cn(
                  'rounded-xl',
                  isRichContent
                    ? 'overflow-hidden'
                    : [
                        'min-w-9 px-3 py-2',
                        isSent
                          ? 'rounded-tr-none bg-linear-to-br from-sky-500 to-blue-500 text-white'
                          : 'rounded-tl-none bg-white shadow-xs dark:bg-zinc-800',
                      ],
                  // Show recalled indicator styling in developer mode
                  isRecalledInDevMode && 'ring-2 ring-amber-500/50 ring-offset-1'
                )}
              >
                {customerServiceContent
                  ? renderCustomerServiceContent(
                      customerServiceContent,
                      emojiInfoMap,
                      onCustomerServiceReply,
                      String(message.msg_key)
                    )
                  : renderMessageContent(message, emojiInfoMap)}
              </div>
            }
          />
          <ContextMenuPopup>
            <ContextMenuItem onClick={handleCopy}>
              <Copy aria-hidden='true' />
              复制
            </ContextMenuItem>
            {isRecallable && onRecall && (
              <ContextMenuItem onClick={handleRecall}>
                <Undo2 aria-hidden='true' />
                撤回
              </ContextMenuItem>
            )}
          </ContextMenuPopup>
        </ContextMenu>
        <div className={`flex items-center gap-1.5 ${isSent ? 'flex-row-reverse' : ''}`}>
          <TimeTooltip timestamp={message.timestamp} className='cursor-default px-1 text-xs text-muted-foreground'>
            {formatTime(message.timestamp)}
          </TimeTooltip>
          {sourceLabel && (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                isAutoReply
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'bg-zinc-200/50 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
              }`}
            >
              {isAutoReply && <Bot className='size-3' aria-hidden='true' />}
              {sourceLabel}
            </span>
          )}
          {developerMode && <MessageInspector message={message} emojiInfoMap={emojiInfoMap} />}
        </div>
      </div>
    </div>
  )
}
