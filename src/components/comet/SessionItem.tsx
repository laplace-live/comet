import { BellOff, Pin, User, Users } from 'lucide-react'
import type { ReactNode } from 'react'

import type { UserCache } from '@/lib/message-utils'
import type { BilibiliSession } from '@/types/bilibili'

import { SESSION_TYPE } from '@/types/bilibili'

import { getLastMessagePreview, getSessionAvatar, getSessionName } from '@/lib/message-utils'
import { cn } from '@/lib/utils'

import { enforceHttps } from '@/utils/enforceHttps'
import { timeFromNow } from '@/utils/timeFromNow'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'

import { getSessionDraft, useDrafts } from '@/stores/useDrafts'
import { Highlight, HighlightExcerpt } from './Highlight'
import { VerifiedBadge } from './VerifiedBadge'

interface SessionItemProps {
  session: BilibiliSession
  /** Draft store key for this session, from getDraftKey() */
  draftKey: string
  /** Whether the row reads as the current one */
  isSelected: boolean
  /**
   * Whether the chat is the one open, its draft being written in the input then: by default, while the row is
   * selected. A search result under the row can be the current one instead.
   */
  isOpen?: boolean
  userCache: UserCache
  /** A search's text, marked in the name and the last message wherever they hold it */
  highlight?: string
  /** Shown in place of the last message and the draft: what a search found the chat by */
  preview?: ReactNode
  onClick: () => void
}

/**
 * Get VIP nickname color if user has active VIP status
 */
function getVipNicknameColor(userCache: UserCache, talkerId: number): string | undefined {
  const cachedUser = userCache[talkerId]
  if (!cachedUser?.vip) return undefined

  const { type, status, nickname_color } = cachedUser.vip
  // VIP is active when both type and status are non-zero
  if (type !== 0 && status !== 0 && nickname_color) {
    return nickname_color
  }
  return undefined
}

export function SessionItem({
  session,
  draftKey,
  isSelected,
  isOpen = isSelected,
  userCache,
  highlight,
  preview,
  onClick,
}: SessionItemProps) {
  const avatar = getSessionAvatar(session, userCache)
  const cachedUser = userCache[session.talker_id]
  const vipNicknameColor = getVipNicknameColor(userCache, session.talker_id)
  // Only mark sessions the user has left; the open one is being edited in the input
  const draft = useDrafts(state => (isOpen ? undefined : getSessionDraft(state.drafts, draftKey)?.trim()))

  return (
    <button
      type='button'
      className={cn(
        'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors select-none hover:bg-accent/50',
        {
          'bg-accent': isSelected,
        }
      )}
      aria-current={isSelected ? 'true' : undefined}
      onClick={onClick}
    >
      <div className='relative'>
        <Avatar className='size-10 ring-2 ring-border/50'>
          {avatar && <AvatarImage src={enforceHttps(avatar)} />}
          <AvatarFallback className='bg-linear-to-br from-pink-400 to-orange-300 text-white'>
            {session.session_type === SESSION_TYPE.FAN_GROUP ? (
              <Users className='size-5' aria-hidden='true' />
            ) : (
              <User className='size-5' aria-hidden='true' />
            )}
          </AvatarFallback>
        </Avatar>
        <VerifiedBadge official={cachedUser?.official} className='absolute -right-0.5 -bottom-0.5' />
      </div>

      <div className='min-w-0 flex-1'>
        <div className='flex items-center justify-between gap-2'>
          <div className='flex min-w-0 items-center gap-1.5'>
            <span className='truncate font-medium' style={vipNicknameColor ? { color: vipNicknameColor } : undefined}>
              {/* Marked in the name's own color, a VIP's too */}
              <Highlight text={getSessionName(session, userCache)} query={highlight} className='text-inherit' />
            </span>
            {session.top_ts > 0 && <Pin className='size-3.5 flex-none text-muted-foreground' aria-label='置顶' />}
            {session.is_dnd === 1 && (
              <BellOff className='size-3.5 flex-none text-muted-foreground' aria-label='免打扰' />
            )}
            {session.is_follow === 1 && (
              <Badge variant='outline' size='sm'>
                关注中
              </Badge>
            )}
          </div>
          {session.last_msg && (
            <span className='flex-none text-xs text-muted-foreground'>
              {timeFromNow(session.last_msg.timestamp * 1000)}
            </span>
          )}
        </div>

        <div className='flex items-center justify-between gap-2'>
          <p className='truncate text-sm text-muted-foreground'>
            {preview !== undefined ? (
              preview
            ) : draft ? (
              <>
                <span className='text-destructive'>[草稿]</span> {draft}
              </>
            ) : (
              <HighlightExcerpt text={getLastMessagePreview(session)} query={highlight} />
            )}
          </p>
          {session.unread_count > 0 && (
            <Badge variant='destructive' size='sm' className='flex-none'>
              {session.unread_count > 99 ? '99+' : session.unread_count}
            </Badge>
          )}
        </div>
      </div>
    </button>
  )
}
