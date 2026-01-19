import { User, Users } from 'lucide-react'

import type { UserCache } from '@/lib/message-utils'
import type { BilibiliSession } from '@/types/bilibili'

import { SESSION_TYPE } from '@/types/bilibili'

import { formatTime, getLastMessagePreview, getSessionAvatar, getSessionName } from '@/lib/message-utils'

import { enforceHttps } from '@/utils/enforceHttps'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'

interface SessionItemProps {
  session: BilibiliSession
  isSelected: boolean
  userCache: UserCache
  onClick: () => void
}

export function SessionItem({ session, isSelected, userCache, onClick }: SessionItemProps) {
  const avatar = getSessionAvatar(session, userCache)

  return (
    <button
      type='button'
      className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent/50 ${
        isSelected ? 'bg-accent' : ''
      }`}
      onClick={onClick}
    >
      <Avatar className='size-10 ring-2 ring-border/50'>
        {avatar && <AvatarImage src={enforceHttps(avatar)} />}
        <AvatarFallback className='bg-linear-to-br from-pink-400 to-orange-300 text-white'>
          {session.session_type === SESSION_TYPE.FAN_GROUP ? <Users className='size-5' /> : <User className='size-5' />}
        </AvatarFallback>
      </Avatar>

      <div className='min-w-0 flex-1'>
        <div className='flex items-center justify-between gap-2'>
          <span className='truncate font-medium'>{getSessionName(session, userCache)}</span>
          {session.last_msg && (
            <span className='flex-none text-muted-foreground text-xs'>{formatTime(session.last_msg.timestamp)}</span>
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
