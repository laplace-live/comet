import { ArrowLeft, Loader2, MessageSquare, RefreshCw, Search, Settings, X } from 'lucide-react'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import type { ScrollerProps } from 'react-virtuoso'
import { Virtuoso } from 'react-virtuoso'

import type { UnfollowedFold } from '@/hooks/usePrivateMessages'
import type { MessageMatch } from '@/lib/account-cache'
import type { UserCache } from '@/lib/message-utils'
import type { BilibiliSession } from '@/types/bilibili'
import type { CheckLoginResult, StoredAccountInfo } from '@/types/electron'

import { chatKey } from '@/lib/account-cache'
import { getLastMessagePreview, getSessionName } from '@/lib/message-utils'

import { isMacOS } from '@/utils/platform'

import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu'
import { Skeleton } from '@/components/ui/skeleton'

import { getDraftKey } from '@/stores/useDrafts'
import { SessionItem } from './SessionItem'
import { UnfollowedFoldItem } from './UnfollowedFoldItem'
import { UserMenu } from './UserMenu'

const CustomScroller = forwardRef<HTMLDivElement, ScrollerProps>(({ children, ...props }, ref) => (
  <div ref={ref} {...props} className='scrollbar-thin'>
    {children}
  </div>
))

type SessionVisibilityFilter = 'all' | 'unread' | 'read'

// How long after asking for a page a search asks for the next, as it loads a long list through, so it keeps under
// Bilibili's rate limit (-509 请求过于频繁)
export const SEARCH_PAGE_GAP = 1000
// How long a search waits for the typing to stop before it looks through the messages held of each chat
const HELD_SEARCH_DELAY = 250

/** Whether a search finds a session by what the list shows of it: its name, UID or last message */
function showsQuery(session: BilibiliSession, query: string, userCache: UserCache): boolean {
  const lower = query.toLowerCase()
  return (
    getSessionName(session, userCache).toLowerCase().includes(lower) ||
    String(session.talker_id).includes(query) ||
    getLastMessagePreview(session).toLowerCase().includes(lower)
  )
}

/**
 * The message held of a chat that a search found it by, when what the list shows of it doesn't hold the text: its
 * result shows that message in place of its last, and opens the chat at it
 */
export function searchMatch(
  session: BilibiliSession,
  query: string,
  userCache: UserCache,
  heldMatches: Map<string, MessageMatch> | null
): MessageMatch | undefined {
  if (!heldMatches || showsQuery(session, query, userCache)) return undefined
  return heldMatches.get(chatKey(session))
}

/**
 * The main list with 未关注人消息's chats among it by time, below the pinned sessions, for a search that looks
 * through both. A chat both hold for a moment (moving between them as it's followed, say) shows once.
 */
function withFoldedChats(sessions: BilibiliSession[], folded: BilibiliSession[]): BilibiliSession[] {
  const listed = new Set(sessions.map(chatKey))
  const rest = [...sessions.filter(s => !s.top_ts), ...folded.filter(s => !listed.has(chatKey(s)))]
  return [...sessions.filter(s => s.top_ts > 0), ...rest.sort((a, b) => b.session_ts - a.session_ts)]
}

/** A row of the list: a session, or 未关注人消息 with the newest of its chats */
type SessionListRow = { type: 'session'; session: BilibiliSession } | { type: 'unfollowed'; newest: BilibiliSession }

/** The chats a search found by the messages held of them, by chat key, for that search and the account shown */
type HeldSearch = { query: string; mid: number | null; matches: Map<string, MessageMatch> }

interface SessionListProps {
  sessions: BilibiliSession[]
  selectedSession: BilibiliSession | null
  loading: boolean
  loadingMore: boolean
  hasMoreSessions: boolean
  isHidden: boolean
  isConnected: boolean
  userCache: UserCache
  userInfo?: CheckLoginResult | null
  accounts?: StoredAccountInfo[]
  activeAccountMid?: number | null
  /** 未关注人消息, while 收起未关注人消息 folds it out of the main list */
  unfollowed?: UnfollowedFold | null
  /** `msgKey`: the message a search found the chat by, to open it at */
  onSessionClick: (session: BilibiliSession, msgKey?: string) => void
  onLoadMore: () => void
  onRefresh: () => void
  onOpenUnfollowed?: () => void
  onCloseUnfollowed?: () => void
  onLoadMoreUnfollowed?: () => void
  /** The chats a message of which holds a search's text, by chat key, each with the newest that does */
  onSearchMessages?: (query: string) => Promise<Map<string, MessageMatch>>
  onLogout?: () => void
  onSwitchAccount?: (mid: number) => void
  onAddAccount?: () => void
  onRemoveAccount?: (mid: number) => void
  onReauthAccount?: (mid: number) => void
}

export function SessionList({
  sessions,
  selectedSession,
  loading,
  loadingMore,
  hasMoreSessions,
  isHidden,
  isConnected,
  userCache,
  userInfo,
  accounts,
  activeAccountMid,
  unfollowed,
  onSessionClick,
  onLoadMore,
  onRefresh,
  onOpenUnfollowed,
  onCloseUnfollowed,
  onLoadMoreUnfollowed,
  onSearchMessages,
  onLogout,
  onSwitchAccount,
  onAddAccount,
  onRemoveAccount,
  onReauthAccount,
}: SessionListProps) {
  const [filterText, setFilterText] = useState('')
  const [visibilityFilter, setVisibilityFilter] = useState<SessionVisibilityFilter>('all')

  // With 未关注人消息 open, the list shows its chats (未关注的人) in place of the main list's
  const showingUnfollowed = !!unfollowed?.open
  const listedSessions = unfollowed?.open ? unfollowed.sessions : sessions
  const hasMoreListed = unfollowed?.open ? unfollowed.hasMore : hasMoreSessions
  const loadingMoreListed = unfollowed?.open ? unfollowed.loadingMore : loadingMore

  const query = filterText.trim()
  const searching = query.length > 0

  // From the main list, a search looks through 未关注人消息's chats too, folded away though they are
  const searchesFolded = searching && !showingUnfollowed && !!unfollowed
  const foldedSessions = unfollowed?.sessions
  const searchedSessions = useMemo(
    () => (searchesFolded && foldedSessions ? withFoldedChats(sessions, foldedSessions) : listedSessions),
    [searchesFolded, sessions, foldedSessions, listedSessions]
  )

  // The chats a message of which holds the search's text, besides the last message the list shows, as held of the
  // chats opened before (on disk too), for the search and account shown
  const [held, setHeld] = useState<HeldSearch | null>(null)
  const shownMid = activeAccountMid ?? null
  useEffect(() => {
    if (!searching || !onSearchMessages) return
    let current = true
    const timer = setTimeout(async () => {
      const matches = await onSearchMessages(query).catch(() => new Map<string, MessageMatch>())
      if (current) setHeld({ query, mid: shownMid, matches })
    }, HELD_SEARCH_DELAY)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [searching, query, shownMid, onSearchMessages])
  const heldMatches = searching && held?.query === query && held.mid === shownMid ? held.matches : null

  // Filter sessions based on visibility filter and search text
  const filteredSessions = useMemo(() => {
    let result = searchedSessions

    // First, apply visibility filter
    if (visibilityFilter === 'unread') {
      result = result.filter(session => session.unread_count > 0)
    } else if (visibilityFilter === 'read') {
      result = result.filter(session => session.unread_count === 0)
    }

    // Then the search: by name, UID or last message, or by any other message held of the chat
    if (query) {
      result = result.filter(session => showsQuery(session, query, userCache) || !!heldMatches?.has(chatKey(session)))
    }

    return result
  }, [searchedSessions, query, visibilityFilter, userCache, heldMatches])

  const isFiltering = searching || visibilityFilter !== 'all'

  // A search looks through every chat in the list, so it loads the rest of the list page by page as it goes (the
  // main list's, then 未关注人消息's when it looks through those too), and the pages stay loaded after. It asks
  // for a page at a time, SEARCH_PAGE_GAP apart. Where a page adds nothing (it failed, say), it stops rather than
  // ask again and again, until the search changes.
  const nextSearchPage = !searching
    ? null
    : !showingUnfollowed && hasMoreSessions
      ? 'sessions'
      : unfollowed?.hasMore
        ? 'unfollowed'
        : null
  const searchPageLoading = loadingMore || !!unfollowed?.loadingMore
  const searchLoadRef = useRef<{ query: string; from: number; at: number } | null>(null)
  useEffect(() => {
    if (!nextSearchPage || searchPageLoading) return
    const last = searchLoadRef.current
    if (last?.query === query && last.from === searchedSessions.length) return
    const ask = () => {
      searchLoadRef.current = { query, from: searchedSessions.length, at: Date.now() }
      if (nextSearchPage === 'unfollowed') onLoadMoreUnfollowed?.()
      else onLoadMore()
    }
    const wait = last ? last.at + SEARCH_PAGE_GAP - Date.now() : 0
    if (wait <= 0) {
      ask()
      return
    }
    const timer = setTimeout(ask, wait)
    return () => clearTimeout(timer)
  }, [query, nextSearchPage, searchPageLoading, searchedSessions.length, onLoadMore, onLoadMoreUnfollowed])
  // Whether pages that may hold what the search looks for are still loading (or about to)
  const stalled = searchLoadRef.current?.query === query && searchLoadRef.current.from === searchedSessions.length
  const searchingMore = !!nextSearchPage && (searchPageLoading || !stalled)

  // The newest chat 未关注人消息 holds, which it previews and is listed by
  const newestUnfollowed = useMemo(
    () =>
      unfollowed?.sessions.reduce<BilibiliSession | null>(
        (newest, session) => (!newest || session.session_ts > newest.session_ts ? session : newest),
        null
      ) ?? null,
    [unfollowed?.sessions]
  )

  // 未关注人消息 takes its place in the main list by its newest chat's time, below the pinned sessions, as
  // Bilibili lists it; older than all that's loaded, it waits at the end for the pages that place it. A search
  // looks through sessions only, but the unread filters go by its unread like any session's.
  const unfollowedUnread = unfollowed?.unread ?? 0
  const rows = useMemo(() => {
    const list: SessionListRow[] = filteredSessions.map(session => ({ type: 'session', session }))
    const shown =
      visibilityFilter === 'all' || (visibilityFilter === 'unread' ? unfollowedUnread > 0 : unfollowedUnread === 0)
    if (showingUnfollowed || searching || !shown || !newestUnfollowed) return list
    const at = filteredSessions.findIndex(s => !s.top_ts && s.session_ts < newestUnfollowed.session_ts)
    list.splice(at === -1 ? list.length : at, 0, { type: 'unfollowed', newest: newestUnfollowed })
    return list
  }, [filteredSessions, showingUnfollowed, searching, visibilityFilter, unfollowedUnread, newestUnfollowed])

  // Handle end reached for infinite scroll - only when not filtering
  const handleEndReached = () => {
    if (hasMoreListed && !loadingMoreListed && !isFiltering) {
      if (showingUnfollowed) onLoadMoreUnfollowed?.()
      else onLoadMore()
    }
  }

  return (
    <div
      className={`flex w-full flex-col border-r border-border/50 bg-white/50 md:w-80 lg:w-96 dark:bg-zinc-900/50 ${isHidden ? 'hidden md:flex' : 'flex'}`}
    >
      {/* Draggable title bar area - only needed on macOS for traffic lights */}
      {isMacOS && <div className='app-region-drag h-8 flex-none' />}

      <div className='flex-none space-y-3 border-b border-border/50 p-4'>
        <div className='sr-only select-none'>
          <h2 className='text-lg font-semibold'>会话列表</h2>
        </div>
        {showingUnfollowed && (
          <div className='app-region-no-drag flex items-center gap-1 select-none'>
            <Button variant='ghost' size='icon-sm' onClick={onCloseUnfollowed} aria-label='返回'>
              <ArrowLeft aria-hidden='true' />
            </Button>
            <h3 className='font-medium'>未关注的人</h3>
          </div>
        )}
        <div className='app-region-no-drag flex items-center gap-2'>
          <InputGroup className='flex-1 select-none'>
            <InputGroupInput
              type='search'
              placeholder='搜索用户名、UID 或内容…'
              aria-label='搜索会话'
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
            />
            <InputGroupAddon align='inline-end'>
              <InputGroupText className='whitespace-nowrap'>
                {isFiltering ? `${filteredSessions.length} / ${searchedSessions.length}` : `${listedSessions.length}`}
              </InputGroupText>

              {filterText && (
                <Button variant='ghost' size='icon-xs' onClick={() => setFilterText('')} aria-label='清除搜索'>
                  <X aria-hidden='true' />
                </Button>
              )}
            </InputGroupAddon>
          </InputGroup>
          <Menu>
            <MenuTrigger
              render={
                <Button variant='ghost' size='icon' disabled={!isConnected} aria-label='会话设置'>
                  <Settings className='size-4' aria-hidden='true' />
                </Button>
              }
            />
            <MenuPopup align='end'>
              <MenuItem onClick={onRefresh} disabled={loading}>
                <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden='true' />
                刷新会话
              </MenuItem>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>显示会话</MenuGroupLabel>
                <MenuRadioGroup
                  value={visibilityFilter}
                  onValueChange={value => setVisibilityFilter(value as SessionVisibilityFilter)}
                >
                  <MenuRadioItem value='all'>全部</MenuRadioItem>
                  <MenuRadioItem value='unread'>仅未读</MenuRadioItem>
                  <MenuRadioItem value='read'>仅已读</MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
            </MenuPopup>
          </Menu>
        </div>
      </div>

      {loading ? (
        <div className='flex-1 overflow-hidden'>
          <SessionListSkeleton />
        </div>
      ) : rows.length === 0 ? (
        <div className='flex-1 overflow-hidden'>
          {searchingMore ? <SessionListSearching /> : isFiltering ? <SessionListNoResults /> : <SessionListEmpty />}
        </div>
      ) : (
        <Virtuoso
          // Each list opens at its top, not at the other's scroll position, nor at another account's
          key={`${activeAccountMid ?? 0}:${showingUnfollowed ? 'unfollowed' : 'sessions'}`}
          className='flex-1'
          data={rows}
          endReached={handleEndReached}
          overscan={20}
          itemContent={(_, row) => {
            if (row.type === 'unfollowed') {
              return (
                <UnfollowedFoldItem
                  newest={row.newest}
                  unread={unfollowedUnread}
                  userCache={userCache}
                  onClick={() => onOpenUnfollowed?.()}
                />
              )
            }
            const match = searchMatch(row.session, query, userCache, heldMatches)
            return (
              <SessionItem
                session={row.session}
                draftKey={getDraftKey(userInfo?.mid ?? 0, row.session)}
                isSelected={selectedSession?.talker_id === row.session.talker_id}
                userCache={userCache}
                preview={match?.text}
                onClick={() => onSessionClick(row.session, match?.msgKey)}
              />
            )
          }}
          components={{
            Scroller: CustomScroller,
            Footer: () =>
              (searching ? searchingMore : hasMoreListed && !isFiltering) ? (
                <div className='flex items-center justify-center p-4'>
                  <Loader2 className='size-5 animate-spin text-muted-foreground' aria-hidden='true' />
                </div>
              ) : null,
          }}
        />
      )}

      <UserMenu
        userInfo={userInfo}
        isConnected={isConnected}
        accounts={accounts}
        activeAccountMid={activeAccountMid}
        onLogout={onLogout}
        onSwitchAccount={onSwitchAccount}
        onAddAccount={onAddAccount}
        onRemoveAccount={onRemoveAccount}
        onReauthAccount={onReauthAccount}
      />
    </div>
  )
}

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed key
        <div key={`skeleton-${i}`} className='flex items-center gap-3 px-4 py-2'>
          <Skeleton className='size-10 rounded-full ring-2 ring-border/50' />
          <div className='flex-1 space-y-2'>
            <Skeleton className='h-5 w-24' />
            <Skeleton className='h-4 w-full' />
          </div>
        </div>
      ))}
    </>
  )
}

function SessionListEmpty() {
  return (
    <div className='flex flex-col items-center justify-center py-16 text-muted-foreground'>
      <MessageSquare className='mb-4 size-12 opacity-50' aria-hidden='true' />
      <p>暂无会话</p>
    </div>
  )
}

function SessionListSearching() {
  return (
    <div className='flex flex-col items-center justify-center py-16 text-muted-foreground'>
      <Loader2 className='mb-4 size-12 animate-spin opacity-50' aria-hidden='true' />
      <p>正在加载更多会话以搜索…</p>
    </div>
  )
}

function SessionListNoResults() {
  return (
    <div className='flex flex-col items-center justify-center py-16 text-muted-foreground'>
      <Search className='mb-4 size-12 opacity-50' aria-hidden='true' />
      <p>没有找到匹配的会话</p>
    </div>
  )
}
