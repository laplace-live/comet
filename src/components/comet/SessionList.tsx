import { ArrowLeft, Loader2, MessageSquare, RefreshCw, Search, Settings, X } from 'lucide-react'
import { forwardRef, useMemo, useState } from 'react'
import type { ScrollerProps } from 'react-virtuoso'
import { Virtuoso } from 'react-virtuoso'

import type { UnfollowedFold } from '@/hooks/usePrivateMessages'
import type { UserCache } from '@/lib/message-utils'
import type { BilibiliSession } from '@/types/bilibili'
import type { CheckLoginResult, StoredAccountInfo } from '@/types/electron'

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

/** A row of the list: a session, or 未关注人消息 with the newest of its chats */
type SessionListRow = { type: 'session'; session: BilibiliSession } | { type: 'unfollowed'; newest: BilibiliSession }

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
  onSessionClick: (session: BilibiliSession) => void
  onLoadMore: () => void
  onRefresh: () => void
  onOpenUnfollowed?: () => void
  onCloseUnfollowed?: () => void
  onLoadMoreUnfollowed?: () => void
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

  // Filter sessions based on visibility filter and search text
  const filteredSessions = useMemo(() => {
    let result = listedSessions

    // First, apply visibility filter
    if (visibilityFilter === 'unread') {
      result = result.filter(session => session.unread_count > 0)
    } else if (visibilityFilter === 'read') {
      result = result.filter(session => session.unread_count === 0)
    }

    // Then, apply search text filter
    if (filterText.trim()) {
      const searchLower = filterText.toLowerCase()
      result = result.filter(session => {
        // Search by username
        const name = getSessionName(session, userCache).toLowerCase()
        if (name.includes(searchLower)) return true

        // Search by uid
        const uid = String(session.talker_id)
        if (uid.includes(filterText.trim())) return true

        // Search by last message content
        const lastMessage = getLastMessagePreview(session).toLowerCase()
        if (lastMessage.includes(searchLower)) return true

        return false
      })
    }

    return result
  }, [listedSessions, filterText, visibilityFilter, userCache])

  const isFiltering = filterText.trim().length > 0 || visibilityFilter !== 'all'

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
    if (showingUnfollowed || filterText.trim() || !shown || !newestUnfollowed) return list
    const at = filteredSessions.findIndex(s => !s.top_ts && s.session_ts < newestUnfollowed.session_ts)
    list.splice(at === -1 ? list.length : at, 0, { type: 'unfollowed', newest: newestUnfollowed })
    return list
  }, [filteredSessions, showingUnfollowed, filterText, visibilityFilter, unfollowedUnread, newestUnfollowed])

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
                {isFiltering ? `${filteredSessions.length} / ${listedSessions.length}` : `${listedSessions.length}`}
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
        <div className='flex-1 overflow-hidden'>{isFiltering ? <SessionListNoResults /> : <SessionListEmpty />}</div>
      ) : (
        <Virtuoso
          // Each list opens at its top, not at the other's scroll position
          key={showingUnfollowed ? 'unfollowed' : 'sessions'}
          className='flex-1'
          data={rows}
          endReached={handleEndReached}
          overscan={20}
          itemContent={(_, row) =>
            row.type === 'unfollowed' ? (
              <UnfollowedFoldItem
                newest={row.newest}
                unread={unfollowedUnread}
                userCache={userCache}
                onClick={() => onOpenUnfollowed?.()}
              />
            ) : (
              <SessionItem
                session={row.session}
                draftKey={getDraftKey(userInfo?.mid ?? 0, row.session)}
                isSelected={selectedSession?.talker_id === row.session.talker_id}
                userCache={userCache}
                onClick={() => onSessionClick(row.session)}
              />
            )
          }
          components={{
            Scroller: CustomScroller,
            Footer: () =>
              hasMoreListed && !isFiltering ? (
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

function SessionListNoResults() {
  return (
    <div className='flex flex-col items-center justify-center py-16 text-muted-foreground'>
      <Search className='mb-4 size-12 opacity-50' aria-hidden='true' />
      <p>没有找到匹配的会话</p>
    </div>
  )
}
