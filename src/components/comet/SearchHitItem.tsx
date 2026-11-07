import { ChevronDown, ChevronUp } from 'lucide-react'

import type { MessageMatch } from '@/lib/account-cache'
import type { UserCache } from '@/lib/message-utils'
import type { BilibiliSession } from '@/types/bilibili'

import { SESSION_TYPE } from '@/types/bilibili'

import { formatTime, getSessionName } from '@/lib/message-utils'
import { cn } from '@/lib/utils'

import { HighlightExcerpt } from './Highlight'

// Results sit under the chat's name and message, past its avatar: px-4, the 40px avatar and gap-3 make pl-17
const RESULT_ROW =
  'relative flex w-full items-center py-1.5 pr-4 pl-17 text-left transition-colors select-none hover:bg-accent/50'

/** The faint line down from the chat's avatar that ties its results to it */
function Guide() {
  return <span className='absolute inset-y-0 left-9 w-px bg-border' aria-hidden='true' />
}

/** Who sent a message a search found: 我 for the account shown, else by name as far as it's known */
function senderName(hit: MessageMatch, session: BilibiliSession, userCache: UserCache, mid: number | null): string {
  if (hit.senderUid === mid) return '我'
  const known = userCache[hit.senderUid]?.name
  if (known) return known
  // In a chat with one person, whoever isn't the account shown is that person
  if (session.session_type === SESSION_TYPE.USER && hit.senderUid === session.talker_id) {
    return getSessionName(session, userCache)
  }
  return `用户 ${hit.senderUid}`
}

interface SearchHitItemProps {
  /** The chat it was found in */
  session: BilibiliSession
  hit: MessageMatch
  /** The search's text, marked where the message holds it */
  query: string
  userCache: UserCache
  /** The account shown, whose own messages read as 我 */
  mid: number | null
  isSelected: boolean
  onClick: () => void
}

/**
 * A message a search found, under its chat: who sent it, what it says from a little before the text found, and when
 * it was sent
 */
export function SearchHitItem({ session, hit, query, userCache, mid, isSelected, onClick }: SearchHitItemProps) {
  return (
    <button
      type='button'
      className={cn(RESULT_ROW, 'gap-2 text-sm', { 'bg-accent': isSelected })}
      aria-current={isSelected ? 'true' : undefined}
      onClick={onClick}
    >
      <Guide />
      {/*
        Who sent it and what it says share the line one to two, each taking what the other leaves: a long name gives
        way to the message the search found, and keeps all of itself beside a short one
      */}
      <span className='flex min-w-0 flex-1'>
        <span className='max-w-max min-w-0 flex-1 truncate text-muted-foreground'>
          {senderName(hit, session, userCache, mid)}
        </span>
        <span className='flex-none text-muted-foreground'>：</span>
        <span className='max-w-max min-w-0 flex-2 truncate text-foreground/80'>
          <HighlightExcerpt text={hit.text} query={query} />
        </span>
      </span>
      <span className='flex-none text-xs text-muted-foreground'>{formatTime(hit.timestamp)}</span>
    </button>
  )
}

interface SearchHitsToggleProps {
  /** How many results the chat has, every one of which shows once it's expanded */
  count: number
  expanded: boolean
  onClick: () => void
}

/** Below a chat's first few results, shows the rest of them, or folds them away again */
export function SearchHitsToggle({ count, expanded, onClick }: SearchHitsToggleProps) {
  const Chevron = expanded ? ChevronUp : ChevronDown
  return (
    <button
      type='button'
      className={cn(RESULT_ROW, 'gap-1 text-xs text-muted-foreground hover:text-foreground')}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <Guide />
      {expanded ? '收起' : `查看全部 ${count} 条`}
      <Chevron className='size-3.5' aria-hidden='true' />
    </button>
  )
}
