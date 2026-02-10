import { forwardRef, memo } from 'react'
import type { ListRange, ScrollerProps, VirtuosoHandle } from 'react-virtuoso'
import { Virtuoso } from 'react-virtuoso'

import type { EmojiInfoMap } from '@/hooks/usePrivateMessages'
import type { UserCache } from '@/lib/message-utils'
import type { BilibiliMessage, BilibiliSession } from '@/types/bilibili'
import type { CheckLoginResult } from '@/types/electron'

import { MessageBubble } from './MessageBubble'

const CustomScroller = forwardRef<HTMLDivElement, ScrollerProps>(({ children, ...props }, ref) => (
  <div ref={ref} {...props} className='scrollbar-thin'>
    {children}
  </div>
))

export interface MessagesListProps {
  messages: BilibiliMessage[]
  emojiInfoMap: EmojiInfoMap
  session: BilibiliSession
  userCache: UserCache
  userInfo: CheckLoginResult | null
  onRecall?: (msgSeqno: number, msgKeyStr: string) => Promise<{ success: boolean; error?: string }>
  virtuosoRef?: React.Ref<VirtuosoHandle>
  initialScrollIndex?: number
  onRangeChanged?: (range: ListRange) => void
}

// Memoized messages list to prevent re-renders when input changes
export const MessagesList = memo(function MessagesList({
  messages,
  emojiInfoMap,
  session,
  userCache,
  userInfo,
  onRecall,
  virtuosoRef,
  initialScrollIndex,
  onRangeChanged,
}: MessagesListProps) {
  return (
    <Virtuoso
      ref={virtuosoRef}
      className='flex-1'
      data={messages}
      overscan={20}
      initialTopMostItemIndex={
        initialScrollIndex !== undefined ? initialScrollIndex : messages.length > 0 ? messages.length - 1 : 0
      }
      followOutput='smooth'
      rangeChanged={onRangeChanged}
      itemContent={(_, msg) => (
        <div className='px-4 pb-4'>
          <MessageBubble
            message={msg}
            emojiInfoMap={emojiInfoMap}
            isSent={msg.sender_uid === userInfo?.mid}
            session={session}
            userCache={userCache}
            userInfo={userInfo}
            onRecall={onRecall}
          />
        </div>
      )}
      components={{
        Scroller: CustomScroller,
        Header: () => <div className='pt-4' />,
      }}
    />
  )
})
