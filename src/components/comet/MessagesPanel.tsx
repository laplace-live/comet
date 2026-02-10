import {
  ArrowDown,
  ArrowLeft,
  Bell,
  BellOff,
  Copy,
  EllipsisVertical,
  ImagePlus,
  MessageSquare,
  User,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ListRange, VirtuosoHandle } from 'react-virtuoso'

import type { EmojiInfoMap } from '@/hooks/usePrivateMessages'
import type { UserCache } from '@/lib/message-utils'
import type { BilibiliMessage, BilibiliSession } from '@/types/bilibili'
import type { CheckLoginResult } from '@/types/electron'

import { SESSION_TYPE } from '@/types/bilibili'

import { MAX_IMAGE_SIZE, SUPPORTED_IMAGE_MIME_TYPES } from '@/lib/const'
import { getSessionAvatar, getSessionName } from '@/lib/message-utils'

import { enforceHttps } from '@/utils/enforceHttps'
import { isMacOS } from '@/utils/platform'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Spinner } from '@/components/ui/spinner'
import { toastManager } from '@/components/ui/toast'

import { MessageInput } from './MessageInput'
import { MessagesList } from './MessagesList'

interface MessagesPanelProps {
  selectedSession: BilibiliSession | null
  messages: BilibiliMessage[]
  emojiInfoMap: EmojiInfoMap
  messagesLoading: boolean
  sendingMessage: boolean
  isVisible: boolean
  userCache: UserCache
  userInfo: CheckLoginResult | null
  onBack: () => void
  onSendMessage: (content: string) => Promise<boolean>
  onSendImage: (imageData: string, mimeType: string) => Promise<boolean>
  onRecall: (msgSeqno: number, msgKeyStr: string) => Promise<{ success: boolean; error?: string }>
  onToggleDnd: (session: BilibiliSession, enabled: boolean) => Promise<boolean>
}

export function MessagesPanel({
  selectedSession,
  messages,
  emojiInfoMap,
  messagesLoading,
  sendingMessage,
  isVisible,
  userCache,
  userInfo,
  onBack,
  onSendMessage,
  onSendImage,
  onRecall,
  onToggleDnd,
}: MessagesPanelProps) {
  // Scroll position cache persists across session switches (survives ChatView unmount/remount)
  const scrollPositionCacheRef = useRef<Map<string, number>>(new Map())

  return (
    <div
      className={`flex flex-1 flex-col bg-linear-to-b from-zinc-50/80 to-zinc-100/80 dark:from-zinc-900 dark:to-zinc-950 ${isVisible ? 'flex' : 'hidden md:flex'}`}
    >
      {selectedSession ? (
        <ChatView
          session={selectedSession}
          messages={messages}
          emojiInfoMap={emojiInfoMap}
          messagesLoading={messagesLoading}
          sendingMessage={sendingMessage}
          userCache={userCache}
          userInfo={userInfo}
          onBack={onBack}
          onSendMessage={onSendMessage}
          onSendImage={onSendImage}
          onRecall={onRecall}
          onToggleDnd={onToggleDnd}
          scrollPositionCacheRef={scrollPositionCacheRef}
        />
      ) : (
        <EmptyState />
      )}
    </div>
  )
}

interface ChatViewProps {
  session: BilibiliSession
  messages: BilibiliMessage[]
  emojiInfoMap: EmojiInfoMap
  messagesLoading: boolean
  sendingMessage: boolean
  userCache: UserCache
  userInfo: CheckLoginResult | null
  onBack: () => void
  onSendMessage: (content: string) => Promise<boolean>
  onSendImage: (imageData: string, mimeType: string) => Promise<boolean>
  onRecall: (msgSeqno: number, msgKeyStr: string) => Promise<{ success: boolean; error?: string }>
  onToggleDnd: (session: BilibiliSession, enabled: boolean) => Promise<boolean>
  scrollPositionCacheRef: React.MutableRefObject<Map<string, number>>
}

function ChatView({
  session,
  messages,
  emojiInfoMap,
  messagesLoading,
  sendingMessage,
  userCache,
  userInfo,
  onBack,
  onSendMessage,
  onSendImage,
  onRecall,
  onToggleDnd,
  scrollPositionCacheRef,
}: ChatViewProps) {
  const avatar = getSessionAvatar(session, userCache)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [droppedFile, setDroppedFile] = useState<File | null>(null)
  const dragCounterRef = useRef(0)

  const sessionName = getSessionName(session, userCache)
  const isDnd = session.is_dnd === 1

  // Scroll position tracking
  const sessionKey = `${session.talker_id}_${session.session_type}`
  const sessionKeyRef = useRef(sessionKey)
  sessionKeyRef.current = sessionKey

  // Get saved scroll position for this session (undefined = new session, scroll to bottom)
  const savedScrollIndex = scrollPositionCacheRef.current.get(sessionKey)

  // Track scroll position changes and save to cache continuously
  const handleRangeChanged = useCallback(
    (range: ListRange) => {
      scrollPositionCacheRef.current.set(sessionKeyRef.current, range.startIndex)
    },
    [scrollPositionCacheRef]
  )

  // New message indicator: track whether user is at bottom and count unseen new messages
  const [isAtBottom, setIsAtBottom] = useState(true)
  const isAtBottomRef = useRef(true)
  const prevMessageCountRef = useRef(messages.length)

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setIsAtBottom(atBottom)
    isAtBottomRef.current = atBottom
  }, [])

  // Count new messages that arrive while user is scrolled up
  const [newMessageCount, setNewMessageCount] = useState(0)

  useEffect(() => {
    const prevCount = prevMessageCountRef.current
    const currentCount = messages.length
    prevMessageCountRef.current = currentCount

    if (currentCount > prevCount && !isAtBottomRef.current) {
      setNewMessageCount(prev => prev + (currentCount - prevCount))
    }
  }, [messages.length])

  // Reset new message count when user scrolls to bottom
  useEffect(() => {
    if (isAtBottom) {
      setNewMessageCount(0)
    }
  }, [isAtBottom])

  // Reset new message indicator when session changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset when session changes
  useEffect(() => {
    setNewMessageCount(0)
    setIsAtBottom(true)
    isAtBottomRef.current = true
    prevMessageCountRef.current = messages.length
  }, [session.talker_id])

  const copyUsername = useCallback(() => {
    navigator.clipboard.writeText(sessionName)
  }, [sessionName])

  const copyUid = useCallback(() => {
    navigator.clipboard.writeText(String(session.talker_id))
  }, [session.talker_id])

  const handleToggleDnd = useCallback(() => {
    onToggleDnd(session, !isDnd)
  }, [session, isDnd, onToggleDnd])

  // Reset state when session changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset state when session changes
  useEffect(() => {
    setDroppedFile(null)
    setIsDragging(false)
    dragCounterRef.current = 0
  }, [session.talker_id])

  const scrollToBottom = useCallback(() => {
    if (messages.length > 0) {
      virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: 'smooth' })
      setNewMessageCount(0)
    }
  }, [messages.length])

  // Drag and drop handlers for image upload
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragging(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    dragCounterRef.current = 0

    const files = e.dataTransfer.files
    if (files.length > 0) {
      const file = files[0]
      // Only accept image types that are supported by the backend
      if (!SUPPORTED_IMAGE_MIME_TYPES.includes(file.type)) {
        return
      }
      // Check file size
      if (file.size > MAX_IMAGE_SIZE) {
        toastManager.add({
          type: 'error',
          title: '图片太大',
          description: `图片大小不能超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB`,
        })
        return
      }
      setDroppedFile(file)
    }
  }, [])

  const handleDroppedFileProcessed = useCallback(() => {
    setDroppedFile(null)
  }, [])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag and drop container for image upload
    <div
      className='relative flex min-h-0 flex-1 flex-col overflow-hidden'
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay indicator */}
      {isDragging && (
        <div className='pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-primary/10'>
          <div className='flex flex-col items-center gap-3 rounded-2xl border-2 border-primary border-dashed bg-background/80 px-12 py-8'>
            <ImagePlus className='size-12 text-primary' aria-hidden='true' />
            <span className='font-medium text-lg text-primary'>松开以发送图片</span>
          </div>
        </div>
      )}

      {/* Chat Header */}
      <div
        className={`app-region-drag flex flex-none select-none items-center gap-3 border-border/50 border-b bg-white/80 px-4 py-3 backdrop-blur-xl dark:bg-zinc-900/80 ${isMacOS ? 'pt-11' : ''}`}
      >
        <Button variant='ghost' size='icon' className='app-region-no-drag md:hidden' onClick={onBack} aria-label='返回'>
          <ArrowLeft aria-hidden='true' />
        </Button>

        <Avatar className='size-10 ring-2 ring-border/50'>
          {avatar && <AvatarImage src={enforceHttps(avatar)} />}
          <AvatarFallback className='bg-linear-to-br from-pink-400 to-orange-300 text-white'>
            {session.session_type === SESSION_TYPE.FAN_GROUP ? (
              <Users className='size-4' aria-hidden='true' />
            ) : (
              <User className='size-4' aria-hidden='true' />
            )}
          </AvatarFallback>
        </Avatar>

        <div className='flex-1'>
          <h3 className='font-semibold'>
            <a
              href={`https://space.bilibili.com/${session.talker_id}`}
              target='_blank'
              rel='noopener noreferrer'
              className='app-region-no-drag'
            >
              {sessionName}
            </a>
          </h3>
          <div className='flex items-center gap-2'>
            {session.is_follow === 1 && (
              <Badge variant='outline' size='sm'>
                关注中
              </Badge>
            )}
            <span className='text-muted-foreground text-xs'>{messages.length || '-'} 条消息</span>
          </div>
        </div>

        {/* User Settings Menu */}
        <Menu>
          <MenuTrigger
            className='app-region-no-drag inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-800'
            aria-label='用户设置'
          >
            <EllipsisVertical className='size-5' aria-hidden='true' />
          </MenuTrigger>
          <MenuPopup align='end'>
            <MenuItem onClick={handleToggleDnd}>
              {isDnd ? (
                <Bell className='size-4' aria-hidden='true' />
              ) : (
                <BellOff className='size-4' aria-hidden='true' />
              )}
              {isDnd ? '开启通知' : '免打扰'}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={copyUsername}>
              <Copy className='size-4' aria-hidden='true' />
              复制用户名
            </MenuItem>
            <MenuItem onClick={copyUid}>
              <Copy className='size-4' aria-hidden='true' />
              {`复制 UID:${session.talker_id}`}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      {/* Messages */}
      {messagesLoading ? (
        <div className='flex flex-1 items-center justify-center py-16'>
          <Spinner className='size-8 text-muted-foreground' aria-hidden='true' />
        </div>
      ) : messages.length === 0 ? (
        <div className='flex flex-1 flex-col items-center justify-center py-16 text-muted-foreground'>
          <MessageSquare className='mb-4 size-12 opacity-50' aria-hidden='true' />
          <p>暂无消息</p>
        </div>
      ) : (
        <MessagesList
          key={sessionKey}
          virtuosoRef={virtuosoRef}
          messages={messages}
          emojiInfoMap={emojiInfoMap}
          session={session}
          userCache={userCache}
          userInfo={userInfo}
          onRecall={onRecall}
          initialScrollIndex={savedScrollIndex}
          onRangeChanged={handleRangeChanged}
          onAtBottomStateChange={handleAtBottomStateChange}
        />
      )}

      {/* Message Input with new messages indicator anchored above it */}
      <div className='relative flex-none'>
        {newMessageCount > 0 && (
          <div className='absolute right-4 bottom-full z-40 mb-2'>
            <button
              type='button'
              onClick={scrollToBottom}
              className='flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 font-medium text-primary-foreground text-xs shadow-lg transition-all hover:bg-primary/90 active:scale-95'
            >
              <ArrowDown className='size-3.5' aria-hidden='true' />
              {newMessageCount} 条新消息
            </button>
          </div>
        )}
        <MessageInput
          sessionId={session.talker_id}
          sendingMessage={sendingMessage}
          droppedFile={droppedFile}
          onSendMessage={onSendMessage}
          onSendImage={onSendImage}
          onMessageSent={scrollToBottom}
          onDroppedFileProcessed={handleDroppedFileProcessed}
        />
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <>
      {/* Draggable title bar area - only needed on macOS for traffic lights */}
      {isMacOS && <div className='app-region-drag h-8 flex-none' />}
      <div className='flex flex-1 flex-col items-center justify-center text-muted-foreground'>
        <div className='mb-6 flex size-24 items-center justify-center rounded-3xl bg-linear-to-br from-zinc-100 to-zinc-200 dark:from-zinc-800 dark:to-zinc-900'>
          <MessageSquare className='size-12 opacity-50' aria-hidden='true' />
        </div>
        <p className='font-medium text-lg'>选择一个会话开始聊天</p>
        <p className='text-sm'>从左侧列表中选择一个会话查看消息</p>
      </div>
    </>
  )
}
