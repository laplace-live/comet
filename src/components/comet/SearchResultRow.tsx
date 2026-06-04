import { Image as ImageIcon, MessageSquareText, Smile, User, Users } from 'lucide-react'

import type { ConversationHit, MessageHit } from '@/api/search-index'
import type { UserCache } from '@/lib/message-utils'

import { SESSION_TYPE } from '@/types/bilibili'

import { formatTime } from '@/lib/message-utils'
import { cn } from '@/lib/utils'

import { enforceHttps } from '@/utils/enforceHttps'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'

import { VerifiedBadge } from './VerifiedBadge'

// Sentinels emitted by FTS5 snippet() / the LIKE fallback; must match the
// main-process query layer (char(1) / char(2), i.e. U+0001 / U+0002).
const MATCH_START = String.fromCharCode(1)
const MATCH_END = String.fromCharCode(2)

interface SearchResultRowProps {
  hit: ConversationHit | MessageHit
  kind: 'conversation' | 'message'
  userCache: UserCache
  isSelected: boolean
  onClick: () => void
}

// Split a snippet on the FTS5 sentinel pair and wrap matched runs in <mark>.
function renderSnippet(snippet: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let buffer = ''
  let inMatch = false
  let key = 0

  const flush = () => {
    if (!buffer) return
    if (inMatch) {
      parts.push(
        <mark key={`m-${key++}`} className='rounded bg-amber-100 px-0.5 text-inherit dark:bg-amber-900/30'>
          {buffer}
        </mark>
      )
    } else {
      parts.push(buffer)
    }
    buffer = ''
  }

  for (const ch of snippet) {
    if (ch === MATCH_START) {
      flush()
      inMatch = true
    } else if (ch === MATCH_END) {
      flush()
      inMatch = false
    } else {
      buffer += ch
    }
  }
  flush()
  return parts.length > 0 ? parts : [snippet]
}

// Icon for a non-text message hit, derived from its type label.
function typeIconFor(typeLabel: string | null): React.ReactNode {
  if (typeLabel === '[图片]') return <ImageIcon className='size-3.5 flex-none' aria-hidden='true' />
  if (typeLabel === '[表情]') return <Smile className='size-3.5 flex-none' aria-hidden='true' />
  return <MessageSquareText className='size-3.5 flex-none' aria-hidden='true' />
}

function avatarFallback(sessionType: number): React.ReactNode {
  return sessionType === SESSION_TYPE.FAN_GROUP ? (
    <Users className='size-5' aria-hidden='true' />
  ) : (
    <User className='size-5' aria-hidden='true' />
  )
}

export function SearchResultRow({ hit, kind, userCache, isSelected, onClick }: SearchResultRowProps) {
  const cachedUser = userCache[hit.talkerId]
  const isConversation = kind === 'conversation'

  // Resolve display name: conversation hits carry name; message hits fall back to cache/sender.
  const name = isConversation
    ? (hit as ConversationHit).name || `用户 ${hit.talkerId}`
    : cachedUser?.name || `用户 ${hit.talkerId}`

  const avatar = cachedUser?.face || null

  // Message hits carry a unix-seconds timestamp; conversation hits omit the time.
  const timeLabel =
    !isConversation && (hit as MessageHit).timestamp ? formatTime((hit as MessageHit).timestamp as number) : null

  // Decide what the secondary line shows.
  const messageHit = !isConversation ? (hit as MessageHit) : null
  const conversationHit = isConversation ? (hit as ConversationHit) : null
  const snippet = messageHit ? messageHit.snippet : (conversationHit?.snippet ?? '')
  const typeLabel = messageHit ? messageHit.typeLabel : null
  const hasSnippet = snippet.trim().length > 0

  return (
    <button
      type='button'
      className={cn(
        'flex w-full select-none items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent/50',
        { 'bg-accent': isSelected }
      )}
      onClick={onClick}
    >
      <div className='relative'>
        <Avatar className='size-10 ring-2 ring-border/50'>
          {avatar && <AvatarImage src={enforceHttps(avatar)} />}
          <AvatarFallback className='bg-linear-to-br from-pink-400 to-orange-300 text-white'>
            {avatarFallback(hit.sessionType)}
          </AvatarFallback>
        </Avatar>
        <VerifiedBadge official={cachedUser?.official} className='absolute -right-0.5 -bottom-0.5' />
      </div>

      <div className='min-w-0 flex-1'>
        <div className='flex items-center justify-between gap-2'>
          <span className='truncate font-medium'>{name}</span>
          {timeLabel && <span className='flex-none text-muted-foreground text-xs'>{timeLabel}</span>}
        </div>

        {hasSnippet ? (
          <p className='line-clamp-2 text-muted-foreground text-sm'>{renderSnippet(snippet)}</p>
        ) : typeLabel ? (
          <p className='flex items-center gap-1 text-muted-foreground text-sm'>
            {typeIconFor(typeLabel)}
            {typeLabel}
          </p>
        ) : (
          <p className='truncate text-muted-foreground text-sm'>—</p>
        )}
      </div>
    </button>
  )
}
