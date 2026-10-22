import { Mail } from 'lucide-react'

import type { UserCache } from '@/lib/message-utils'
import type { BilibiliSession } from '@/types/bilibili'

import { getLastMessagePreview, getSessionName } from '@/lib/message-utils'

import { timeFromNow } from '@/utils/timeFromNow'

interface UnfollowedFoldItemProps {
  /** The newest of the chats it holds, which it previews */
  newest: BilibiliSession
  /** Unread across all of them */
  unread: number
  userCache: UserCache
  onClick: () => void
}

/**
 * 未关注人消息 in the main list, standing in for the chats 收起未关注人消息 folds there. It looks as in
 * Bilibili's web client: its newest chat's message after who sent it, with a dot and the unread count in
 * front while any is unread.
 */
export function UnfollowedFoldItem({ newest, unread, userCache, onClick }: UnfollowedFoldItemProps) {
  const preview = `${unread > 0 ? `[${unread}条]` : ''}${getSessionName(newest, userCache)}：${getLastMessagePreview(newest)}`

  return (
    <button
      type='button'
      className='flex w-full items-center gap-3 px-4 py-2 text-left transition-colors select-none hover:bg-accent/50'
      onClick={onClick}
    >
      <div className='flex size-10 flex-none items-center justify-center rounded-full bg-[#fb7299] text-white ring-2 ring-border/50'>
        <Mail className='size-5' aria-hidden='true' />
      </div>

      <div className='min-w-0 flex-1'>
        <div className='flex items-center justify-between gap-2'>
          <span className='truncate font-medium'>未关注人消息</span>
          {newest.last_msg && (
            <span className='flex-none text-xs text-muted-foreground'>
              {timeFromNow(newest.last_msg.timestamp * 1000)}
            </span>
          )}
        </div>

        <div className='flex items-center justify-between gap-2'>
          <p className='truncate text-sm text-muted-foreground'>{preview}</p>
          {/* The count in front of the preview says it in words */}
          {unread > 0 && <span className='size-2 flex-none rounded-full bg-destructive' aria-hidden='true' />}
        </div>
      </div>
    </button>
  )
}
