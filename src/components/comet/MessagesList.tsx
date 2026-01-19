import { memo } from 'react'

import type { EmojiInfoMap } from '@/hooks/usePrivateMessages'
import type { UserCache } from '@/lib/message-utils'
import type { BilibiliMessage, BilibiliSession } from '@/types/bilibili'
import type { CheckLoginResult } from '@/types/electron'

import { MessageBubble } from './MessageBubble'

export interface MessagesListProps {
  messages: BilibiliMessage[]
  emojiInfoMap: EmojiInfoMap
  session: BilibiliSession
  userCache: UserCache
  userInfo: CheckLoginResult | null
  onRecall?: (msgSeqno: number, msgKeyStr: string) => Promise<{ success: boolean; error?: string }>
}

// Memoized messages list to prevent re-renders when input changes
export const MessagesList = memo(function MessagesList({
  messages,
  emojiInfoMap,
  session,
  userCache,
  userInfo,
  onRecall,
}: MessagesListProps) {
  return (
    <div className='space-y-4'>
      {messages.map(msg => (
        <MessageBubble
          key={msg.msg_key}
          message={msg}
          emojiInfoMap={emojiInfoMap}
          isSent={msg.receiver_id === session.talker_id}
          session={session}
          userCache={userCache}
          userInfo={userInfo}
          onRecall={onRecall}
        />
      ))}
    </div>
  )
})
