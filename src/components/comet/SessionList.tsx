import { ArrowLeft, Loader2, MessageSquare, RefreshCw, Search, Settings, X } from 'lucide-react'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import type { ScrollerProps } from 'react-virtuoso'
import { Virtuoso } from 'react-virtuoso'

import type { SearchOpening, UnfollowedFold } from '@/hooks/usePrivateMessages'
import type { MessageMatch } from '@/lib/account-cache'
import type { UserCache } from '@/lib/message-utils'
import type { ChatFound } from '@/lib/search'
import type { BilibiliSession } from '@/types/bilibili'
import type { CheckLoginResult, StoredAccountInfo } from '@/types/electron'

import { chatKey } from '@/lib/account-cache'
import { findChat } from '@/lib/search'

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
import { HighlightExcerpt } from './Highlight'
import { SearchHitItem, SearchHitsToggle } from './SearchHitItem'
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
// How many of the messages a search found in a chat show under it before 查看全部 shows the rest
const SHOWN_HITS = 3

/**
 * The main list with 未关注人消息's chats among it by time, below the pinned sessions, for a search that looks
 * through both. A chat both hold for a moment (moving between them as it's followed, say) shows once.
 */
function withFoldedChats(sessions: BilibiliSession[], folded: BilibiliSession[]): BilibiliSession[] {
  const listed = new Set(sessions.map(chatKey))
  const rest = [...sessions.filter(s => !s.top_ts), ...folded.filter(s => !listed.has(chatKey(s)))]
  return [...sessions.filter(s => s.top_ts > 0), ...rest.sort((a, b) => b.session_ts - a.session_ts)]
}

/**
 * The messages a search found in a chat that show as rows under it. Found by its name, those besides its last, which
 * its own row shows; found by its messages alone, every one, unless it's just the one, which its own row shows.
 */
function hitRowsOf(session: BilibiliSession, found: ChatFound): MessageMatch[] {
  if (!found.byName) return found.hits.length > 1 ? found.hits : []
  const last = String(session.last_msg?.msg_key)
  return found.hits.filter(hit => hit.msgKey !== last)
}

/** What a chat's row shows in place of its last message, when a search found it by its messages alone */
function foundPreview(found: ChatFound, query: string) {
  if (found.byName) return undefined
  if (found.hits.length > 1) return `${found.hits.length} 条相关消息`
  return <HighlightExcerpt text={found.hits[0].text} query={query} />
}

/** How a search result opens its chat: found by its name, at its newest; found by its messages, at the newest of them */
function openingOf(found: ChatFound, query: string): SearchOpening {
  return found.byName ? { query } : { msgKey: found.hits[0].msgKey, query }
}

/**
 * A row of the list: a session; 未关注人消息 with the newest of its chats; or, during a search, a message found in
 * the session above, and below the first few of those, the toggle that shows the rest
 */
type SessionListRow =
  | {
      type: 'session'
      session: BilibiliSession
      /** What the search found of it, null outside a search */
      found: ChatFound | null
    }
  | { type: 'unfollowed'; newest: BilibiliSession }
  | { type: 'hit'; session: BilibiliSession; hit: MessageMatch }
  | { type: 'more'; session: BilibiliSession; count: number; expanded: boolean }

/** Keys a row keeps while rows come and go around it, as a chat's results expand */
function rowKey(row: SessionListRow): string {
  switch (row.type) {
    case 'session':
      return `s:${chatKey(row.session)}`
    case 'hit':
      return `h:${chatKey(row.session)}:${row.hit.msgKey}`
    case 'more':
      return `m:${chatKey(row.session)}`
    case 'unfollowed':
      return 'u'
  }
}

/** The chats whose results all show (查看全部), for the search and account they were expanded in */
type ExpandedChats = { query: string; mid: number | null; keys: ReadonlySet<string> }

/** The chats a search found by the messages held of them, by chat key, for that search and the account shown */
type HeldSearch = { query: string; mid: number | null; matches: Map<string, MessageMatch[]> }

/** A next page a search asks for: for what text, of which list of which account, from how many chats listed */
type SearchPage = { query: string; mid: number | null; list: 'sessions' | 'unfollowed'; from: number }

/** Whether two asks are for the same page, the second asking again for one that added nothing */
function isSamePage(a: SearchPage | null, b: SearchPage): boolean {
  return !!a && a.query === b.query && a.mid === b.mid && a.list === b.list && a.from === b.from
}

interface SessionListProps {
  sessions: BilibiliSession[]
  selectedSession: BilibiliSession | null
  /** The message the selected chat was opened at, from a search: its result reads as the current row, not the chat */
  openedMsgKey?: string | null
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
  /** `search`: how a search result opens the chat, at the message it found */
  onSessionClick: (session: BilibiliSession, search?: SearchOpening) => void
  onLoadMore: () => void
  onRefresh: () => void
  onOpenUnfollowed?: () => void
  onCloseUnfollowed?: () => void
  onLoadMoreUnfollowed?: () => void
  /** The chats with messages holding a search's text, by chat key, each with every one that does, newest first */
  onSearchMessages?: (query: string) => Promise<Map<string, MessageMatch[]>>
  onLogout?: () => void
  onSwitchAccount?: (mid: number) => void
  onAddAccount?: () => void
  onRemoveAccount?: (mid: number) => void
  onReauthAccount?: (mid: number) => void
}

export function SessionList({
  sessions,
  selectedSession,
  openedMsgKey,
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
      const matches = await onSearchMessages(query).catch(() => new Map<string, MessageMatch[]>())
      if (current) setHeld({ query, mid: shownMid, matches })
    }, HELD_SEARCH_DELAY)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [searching, query, shownMid, onSearchMessages])
  const heldMatches = searching && held?.query === query && held.mid === shownMid ? held.matches : null

  // Filter sessions based on visibility filter and search text, each with what the search found of it
  const filteredSessions = useMemo(() => {
    let result = searchedSessions

    // First, apply visibility filter
    if (visibilityFilter === 'unread') {
      result = result.filter(session => session.unread_count > 0)
    } else if (visibilityFilter === 'read') {
      result = result.filter(session => session.unread_count === 0)
    }

    // Then the search: by name, UID or last message, or by any other message held of the chat
    const chats = result.map(session => ({
      session,
      found: query ? findChat(session, query, userCache, heldMatches) : null,
    }))
    return query ? chats.filter(chat => chat.found !== null) : chats
  }, [searchedSessions, query, visibilityFilter, userCache, heldMatches])

  // A search shows the first few of a chat's results until 查看全部 shows them all, for that search on that account
  const [expansion, setExpansion] = useState<ExpandedChats | null>(null)
  const expandedChats = expansion?.query === query && expansion.mid === shownMid ? expansion.keys : null
  const toggleExpanded = (key: string) => {
    const keys = new Set(expandedChats)
    if (keys.has(key)) keys.delete(key)
    else keys.add(key)
    setExpansion({ query, mid: shownMid, keys })
  }

  const isFiltering = searching || visibilityFilter !== 'all'

  // A search looks through every chat in the list, so it loads the rest of the list page by page as it goes (the
  // main list's, then 未关注人消息's when it looks through those too), and the pages stay loaded after. It asks
  // for a page at a time, SEARCH_PAGE_GAP apart. Where a page adds nothing (it failed, say), it stops rather than
  // ask again and again, until the search, the list it pages or the account changes.
  const nextSearchPage = !searching
    ? null
    : !showingUnfollowed && hasMoreSessions
      ? 'sessions'
      : unfollowed?.hasMore
        ? 'unfollowed'
        : null
  const searchPage: SearchPage | null = nextSearchPage && {
    query,
    mid: shownMid,
    list: nextSearchPage,
    from: searchedSessions.length,
  }
  const searchPageLoading = loadingMore || !!unfollowed?.loadingMore
  // The page asked for last, and when
  const searchLoadRef = useRef<(SearchPage & { at: number }) | null>(null)
  useEffect(() => {
    const last = searchLoadRef.current
    // Cleared, a search typed again asks again, though still SEARCH_PAGE_GAP after the last
    if (!searching) {
      if (last?.query) searchLoadRef.current = { ...last, query: '' }
      return
    }
    if (!nextSearchPage || searchPageLoading) return
    const page: SearchPage = { query, mid: shownMid, list: nextSearchPage, from: searchedSessions.length }
    if (isSamePage(last, page)) return
    const ask = () => {
      searchLoadRef.current = { ...page, at: Date.now() }
      if (page.list === 'unfollowed') onLoadMoreUnfollowed?.()
      else onLoadMore()
    }
    const wait = last ? last.at + SEARCH_PAGE_GAP - Date.now() : 0
    if (wait <= 0) {
      ask()
      return
    }
    const timer = setTimeout(ask, wait)
    return () => clearTimeout(timer)
  }, [
    searching,
    query,
    shownMid,
    nextSearchPage,
    searchPageLoading,
    searchedSessions.length,
    onLoadMore,
    onLoadMoreUnfollowed,
  ])
  // Whether pages that may hold what the search looks for are still loading (or about to)
  const stalled = !!searchPage && isSamePage(searchLoadRef.current, searchPage)
  const searchingMore = !!searchPage && (searchPageLoading || !stalled)
  // Whether the messages held are still being searched, for chats only they'd find
  const heldPending = searching && !!onSearchMessages && heldMatches === null

  // The newest chat 未关注人消息 holds, which it previews and is listed by
  const newestUnfollowed = useMemo(
    () =>
      unfollowed?.sessions.reduce<BilibiliSession | null>(
        (newest, session) => (!newest || session.session_ts > newest.session_ts ? session : newest),
        null
      ) ?? null,
    [unfollowed?.sessions]
  )

  // A search lists the messages it found in a chat under it, newest first, the first few until 查看全部.
  // 未关注人消息 takes its place in the main list by its newest chat's time, below the pinned sessions, as
  // Bilibili lists it; older than all that's loaded, it waits at the end for the pages that place it. A search
  // looks through sessions only, but the unread filters go by its unread like any session's.
  const unfollowedUnread = unfollowed?.unread ?? 0
  const rows = useMemo(() => {
    const list: SessionListRow[] = []
    for (const { session, found } of filteredSessions) {
      const hits = found ? hitRowsOf(session, found) : []
      const expanded = !!expandedChats?.has(chatKey(session))
      const shownHits = expanded ? hits : hits.slice(0, SHOWN_HITS)
      list.push({ type: 'session', session, found })
      for (const hit of shownHits) list.push({ type: 'hit', session, hit })
      if (hits.length > SHOWN_HITS) list.push({ type: 'more', session, count: hits.length, expanded })
    }
    const shown =
      visibilityFilter === 'all' || (visibilityFilter === 'unread' ? unfollowedUnread > 0 : unfollowedUnread === 0)
    if (showingUnfollowed || searching || !shown || !newestUnfollowed) return list
    const at = filteredSessions.findIndex(({ session: s }) => !s.top_ts && s.session_ts < newestUnfollowed.session_ts)
    list.splice(at === -1 ? list.length : at, 0, { type: 'unfollowed', newest: newestUnfollowed })
    return list
  }, [
    filteredSessions,
    expandedChats,
    showingUnfollowed,
    searching,
    visibilityFilter,
    unfollowedUnread,
    newestUnfollowed,
  ])

  // Messages from the account shown read as 我 among a search's results
  const myMid = activeAccountMid ?? userInfo?.mid ?? null
  const isSelectedChat = (session: BilibiliSession) => selectedSession?.talker_id === session.talker_id
  // The result the open chat was opened at, while it shows: it reads as the current row in place of the chat
  const openedHit = rows.find(
    row => row.type === 'hit' && isSelectedChat(row.session) && row.hit.msgKey === openedMsgKey
  )

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
          {searchingMore || heldPending ? (
            <SessionListSearching />
          ) : isFiltering ? (
            <SessionListNoResults />
          ) : (
            <SessionListEmpty />
          )}
        </div>
      ) : (
        <Virtuoso
          // Each list opens at its top, not at the other's scroll position, nor at another account's
          key={`${activeAccountMid ?? 0}:${showingUnfollowed ? 'unfollowed' : 'sessions'}`}
          className='flex-1'
          data={rows}
          computeItemKey={(_, row) => rowKey(row)}
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
            if (row.type === 'hit') {
              return (
                <SearchHitItem
                  session={row.session}
                  hit={row.hit}
                  query={query}
                  userCache={userCache}
                  mid={myMid}
                  isSelected={row === openedHit}
                  onClick={() => onSessionClick(row.session, { msgKey: row.hit.msgKey, query })}
                />
              )
            }
            if (row.type === 'more') {
              return (
                <SearchHitsToggle
                  count={row.count}
                  expanded={row.expanded}
                  onClick={() => toggleExpanded(chatKey(row.session))}
                />
              )
            }
            const { session, found } = row
            const selected = isSelectedChat(session)
            return (
              <SessionItem
                session={session}
                draftKey={getDraftKey(userInfo?.mid ?? 0, session)}
                isSelected={selected && !openedHit}
                isOpen={selected}
                userCache={userCache}
                highlight={query}
                preview={found ? foundPreview(found, query) : undefined}
                onClick={() => onSessionClick(session, found ? openingOf(found, query) : undefined)}
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
