import { User, Users } from 'lucide-react'

import type { UserCache } from '@/lib/message-utils'
import type { BilibiliSession } from '@/types/bilibili'

import { SESSION_TYPE } from '@/types/bilibili'

import { getLastMessagePreview, getSessionAvatar, getSessionName } from '@/lib/message-utils'

import { enforceHttps } from '@/utils/enforceHttps'
import { timeFromNow } from '@/utils/timeFromNow'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'

import { VerifiedBadge } from './VerifiedBadge'

interface SessionItemProps {
  session: BilibiliSession
  isSelected: boolean
  userCache: UserCache
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

export function SessionItem({ session, isSelected, userCache, onClick }: SessionItemProps) {
  const avatar = getSessionAvatar(session, userCache)
  const cachedUser = userCache[session.talker_id]
  const vipNicknameColor = getVipNicknameColor(userCache, session.talker_id)

  return (
    <button
      type='button'
      className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent/50 ${
        isSelected ? 'bg-accent' : ''
      }`}
      onClick={onClick}
    >
      <div className='relative'>
        <Avatar className='size-10 ring-2 ring-border/50'>
          {avatar && <AvatarImage src={enforceHttps(avatar)} />}
          <AvatarFallback className='bg-linear-to-br from-pink-400 to-orange-300 text-white'>
            {session.session_type === SESSION_TYPE.FAN_GROUP ? (
              <Users className='size-5' />
            ) : (
              <User className='size-5' />
            )}
          </AvatarFallback>
        </Avatar>
        <VerifiedBadge official={cachedUser?.official} className='absolute -top-0.5 -right-0.5' />
      </div>

      <div className='min-w-0 flex-1'>
        <div className='flex items-center justify-between gap-2'>
          <span className='truncate font-medium' style={vipNicknameColor ? { color: vipNicknameColor } : undefined}>
            {getSessionName(session, userCache)}
          </span>
          {session.last_msg && (
            <span className='flex-none text-muted-foreground text-xs'>
              {timeFromNow(session.last_msg.timestamp * 1000)}
            </span>
          )}
        </div>

        <div className='flex items-center justify-between gap-2'>
          <p className='truncate text-muted-foreground text-sm'>{getLastMessagePreview(session)}</p>
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
