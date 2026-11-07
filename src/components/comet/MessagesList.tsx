import { forwardRef, memo, useEffect, useState } from 'react'
import type { IndexLocationWithAlign, ScrollerProps, VirtuosoHandle } from 'react-virtuoso'
import { Virtuoso } from 'react-virtuoso'

import type { EmojiInfoMap, TargetMessage } from '@/hooks/usePrivateMessages'
import type { CustomerServiceReply } from '@/lib/customer-service'
import type { UserCache } from '@/lib/message-utils'
import type { BilibiliMessage, BilibiliSession } from '@/types/bilibili'
import type { CheckLoginResult } from '@/types/electron'

import { cn } from '@/lib/utils'

import { MessageBubble } from './MessageBubble'

// How long the message a chat opened at stays marked, to stand out from the ones around it
const TARGET_MARK_TIME = 2000

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
  onCustomerServiceReply?: (reply: CustomerServiceReply) => Promise<boolean>
  virtuosoRef?: React.Ref<VirtuosoHandle>
  /** A message to open at in place of the newest, marked a moment: the one a search found the chat by */
  targetMessage?: TargetMessage | null
}

// Memoized messages list to prevent re-renders when input changes
export const MessagesList = memo(function MessagesList({
  messages,
  emojiInfoMap,
  session,
  userCache,
  userInfo,
  onRecall,
  onCustomerServiceReply,
  virtuosoRef,
  targetMessage,
}: MessagesListProps) {
  // Where the list opens as it mounts (it's mounted again for each chat, and each time one opens at a message): at
  // the target message, centered, when it holds it, else at the newest
  const [opening] = useState((): { at: IndexLocationWithAlign | number; marked: string | null } => {
    const index = targetMessage ? messages.findIndex(m => String(m.msg_key) === targetMessage.msgKey) : -1
    if (!targetMessage || index === -1) return { at: Math.max(messages.length - 1, 0), marked: null }
    return { at: { index, align: 'center' }, marked: targetMessage.msgKey }
  })
  const [marked, setMarked] = useState(opening.marked)
  useEffect(() => {
    if (marked === null) return
    const timer = setTimeout(() => setMarked(null), TARGET_MARK_TIME)
    return () => clearTimeout(timer)
  }, [marked])

  return (
    <Virtuoso
      ref={virtuosoRef}
      className='flex-1'
      data={messages}
      overscan={20}
      initialTopMostItemIndex={opening.at}
      followOutput='smooth'
      itemContent={(_, msg) => (
        <div className='px-4 pb-4'>
          <div
            data-target={String(msg.msg_key) === marked || undefined}
            className={cn(
              'rounded-xl ring-8 ring-transparent transition-[background-color,box-shadow] duration-1000',
              'data-target:bg-amber-300/25 data-target:ring-amber-300/25',
              'dark:data-target:bg-amber-400/15 dark:data-target:ring-amber-400/15'
            )}
          >
            <MessageBubble
              message={msg}
              emojiInfoMap={emojiInfoMap}
              isSent={msg.sender_uid === userInfo?.mid}
              session={session}
              userCache={userCache}
              userInfo={userInfo}
              onRecall={onRecall}
              onCustomerServiceReply={onCustomerServiceReply}
            />
          </div>
        </div>
      )}
      components={{
        Scroller: CustomScroller,
        Header: () => <div className='pt-4' />,
      }}
    />
  )
})
