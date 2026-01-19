import { memo } from 'react'

import type { UserCache } from '@/lib/message-utils'
import type { BilibiliMessage, BilibiliSession } from '@/types/bilibili'
import type { CheckLoginResult } from '@/types/electron'

import { MessageBubble } from './MessageBubble'

export interface MessagesListProps {
  messages: BilibiliMessage[]
  session: BilibiliSession
  userCache: UserCache
  userInfo: CheckLoginResult | null
}

// Memoized messages list to prevent re-renders when input changes
export const MessagesList = memo(function MessagesList({ messages, session, userCache, userInfo }: MessagesListProps) {
  return (
    <div className='space-y-4'>
      {messages.map(msg => (
        <MessageBubble
          key={msg.msg_key}
          message={msg}
          isSent={msg.receiver_id === session.talker_id}
          session={session}
          userCache={userCache}
          userInfo={userInfo}
        />
      ))}
    </div>
  )
})
