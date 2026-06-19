import { ArrowRight, Loader2, Search } from 'lucide-react'
import { forwardRef } from 'react'
import type { ScrollerProps } from 'react-virtuoso'
import { Virtuoso } from 'react-virtuoso'

import type { ConversationHit, MessageHit, SearchQueryResult } from '@/api/search-index'
import type { UserCache } from '@/lib/message-utils'

import { Button } from '@/components/ui/button'
import { Progress, ProgressIndicator, ProgressTrack } from '@/components/ui/progress'

import { SearchResultRow } from './SearchResultRow'

const CustomScroller = forwardRef<HTMLDivElement, ScrollerProps>(({ children, ...props }, ref) => (
  <div ref={ref} {...props} className='scrollbar-thin'>
    {children}
  </div>
))

interface SearchResultsProps {
  results: SearchQueryResult | null
  loading: boolean
  userCache: UserCache
  selectedTalkerId: number | null
  /** Index on: true if full-text index is enabled. */
  indexEnabled: boolean
  /** Backfill is mid-flight (determinate progress shown atop messages group). */
  backfillRunning: boolean
  /** 0..1 determinate progress for the in-progress banner. */
  backfillProgress: number
  onConversationClick: (hit: ConversationHit) => void
  onMessageClick: (hit: MessageHit) => void
  onLoadMoreMessages: () => void
  onOpenSettings: () => void
}

export function SearchResults({
  results,
  loading,
  userCache,
  selectedTalkerId,
  indexEnabled,
  backfillRunning,
  backfillProgress,
  onConversationClick,
  onMessageClick,
  onLoadMoreMessages,
  onOpenSettings,
}: SearchResultsProps) {
  const conversationHits = results?.conversationHits ?? []
  const messageHits = results?.messageHits ?? []

  // Coverage caveat: index off OR mid-backfill → only loaded/indexed data is searched.
  const showCaveat = !indexEnabled || backfillRunning

  if (loading && !results) {
    return (
      <div className='flex flex-1 items-center justify-center'>
        <Loader2 className='size-5 animate-spin text-muted-foreground' aria-hidden='true' />
      </div>
    )
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      {showCaveat && (
        <div className='flex-none border-border/50 border-b bg-amber-50/60 px-4 py-1.5 text-amber-700 text-xs dark:bg-amber-900/15 dark:text-amber-400'>
          仅搜索已加载/已索引的消息
        </div>
      )}

      {/* Conversations group (static, non-scrolling) */}
      <div className='flex-none'>
        <div className='px-4 pt-3 pb-1 font-medium text-muted-foreground text-xs'>会话 · {conversationHits.length}</div>
        {conversationHits.length === 0 ? (
          <p className='px-4 pb-3 text-muted-foreground text-sm'>没有匹配的会话</p>
        ) : (
          conversationHits.map(hit => (
            <SearchResultRow
              key={`conv-${hit.sessionType}-${hit.talkerId}`}
              hit={hit}
              kind='conversation'
              userCache={userCache}
              isSelected={selectedTalkerId === hit.talkerId}
              onClick={() => onConversationClick(hit)}
            />
          ))
        )}

        {/* Messages group header */}
        <div className='px-4 pt-3 pb-1 font-medium text-muted-foreground text-xs'>消息 · {messageHits.length}</div>

        {backfillRunning && (
          <div className='px-4 pb-2'>
            <Progress value={Math.round(backfillProgress * 100)}>
              <ProgressTrack className='h-1'>
                <ProgressIndicator style={{ width: `${Math.round(backfillProgress * 100)}%` }} />
              </ProgressTrack>
            </Progress>
          </div>
        )}
      </div>

      {/* Messages group body: self-scrolling virtualized list (owns its own scroll). */}
      {!indexEnabled ? (
        <div className='flex flex-col items-start gap-2 px-4 py-4 text-muted-foreground text-sm'>
          <p>开启全文搜索以检索全部历史消息</p>
          <Button variant='outline' size='sm' onClick={onOpenSettings}>
            前往设置
            <ArrowRight className='size-4' aria-hidden='true' />
          </Button>
        </div>
      ) : messageHits.length === 0 ? (
        <div className='flex flex-col items-center justify-center py-8 text-muted-foreground'>
          <Search className='mb-3 size-8 opacity-50' aria-hidden='true' />
          <p className='text-sm'>没有匹配的消息</p>
        </div>
      ) : (
        <Virtuoso
          className='flex-1'
          data={messageHits}
          endReached={onLoadMoreMessages}
          overscan={20}
          itemContent={(_, hit) => (
            <SearchResultRow
              hit={hit}
              kind='message'
              userCache={userCache}
              isSelected={false}
              onClick={() => onMessageClick(hit)}
            />
          )}
          components={{ Scroller: CustomScroller }}
        />
      )}
    </div>
  )
}
