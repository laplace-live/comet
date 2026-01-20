import { Loader2, MessageSquare, RefreshCw, Search, Settings, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

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
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'

import { SessionItem } from './SessionItem'
import { UserMenu } from './UserMenu'

type SessionVisibilityFilter = 'all' | 'unread' | 'read'

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
  onSessionClick: (session: BilibiliSession) => void
  onLoadMore: () => void
  onRefresh: () => void
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
  onSessionClick,
  onLoadMore,
  onRefresh,
  onLogout,
  onSwitchAccount,
  onAddAccount,
  onRemoveAccount,
  onReauthAccount,
}: SessionListProps) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [filterText, setFilterText] = useState('')
  const [visibilityFilter, setVisibilityFilter] = useState<SessionVisibilityFilter>('all')

  // Filter sessions based on visibility filter and search text
  const filteredSessions = useMemo(() => {
    let result = sessions

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
  }, [sessions, filterText, visibilityFilter, userCache])

  // Auto-load more when sentinel becomes visible
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMoreSessions || loadingMore) return

    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasMoreSessions && !loadingMore) {
          onLoadMore()
        }
      },
      { threshold: 0.1 }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMoreSessions, loadingMore, onLoadMore])

  const isFiltering = filterText.trim().length > 0 || visibilityFilter !== 'all'

  return (
    <div
      className={`flex w-full flex-col border-border/50 border-r bg-white/50 md:w-80 lg:w-96 dark:bg-zinc-900/50 ${isHidden ? 'hidden md:flex' : 'flex'}`}
    >
      {/* Draggable title bar area - only needed on macOS for traffic lights */}
      {isMacOS && <div className='app-region-drag h-8 flex-none' />}

      <div className='flex-none space-y-3 border-border/50 border-b p-4'>
        <div className='sr-only select-none'>
          <h2 className='font-semibold text-lg'>会话列表</h2>
        </div>
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
                {isFiltering ? `${filteredSessions.length} / ${sessions.length}` : `${sessions.length}`}
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

      <ScrollArea className='flex-1'>
        <div>
          {loading ? (
            <SessionListSkeleton />
          ) : filteredSessions.length === 0 ? (
            isFiltering ? (
              <SessionListNoResults />
            ) : (
              <SessionListEmpty />
            )
          ) : (
            <>
              {filteredSessions.map(session => (
                <SessionItem
                  key={`${session.session_type}-${session.talker_id}`}
                  session={session}
                  isSelected={selectedSession?.talker_id === session.talker_id}
                  userCache={userCache}
                  onClick={() => onSessionClick(session)}
                />
              ))}
              {/* Sentinel element for infinite scroll - only show when not filtering */}
              {hasMoreSessions && !isFiltering && (
                <div ref={sentinelRef} className='flex items-center justify-center p-4'>
                  <Loader2 className='size-5 animate-spin text-muted-foreground' aria-hidden='true' />
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

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
          <Skeleton className='size-10 rounded-full' />
          <div className='flex-1 space-y-2'>
            <Skeleton className='h-4 w-24' />
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
