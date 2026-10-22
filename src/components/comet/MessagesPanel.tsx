import {
  ArrowLeft,
  Bell,
  BellOff,
  ChevronDown,
  Copy,
  EllipsisVertical,
  ImagePlus,
  MessageSquare,
  Pin,
  PinOff,
  User,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'

import type { EmojiInfoMap } from '@/hooks/usePrivateMessages'
import type { CustomerServiceReply } from '@/lib/customer-service'
import type { UserCache } from '@/lib/message-utils'
import type { BilibiliMessage, BilibiliSession, CustomerServiceSession } from '@/types/bilibili'
import type { CheckLoginResult, CustomerServiceShop } from '@/types/electron'

import { SESSION_TYPE } from '@/types/bilibili'

import { MAX_IMAGE_SIZE, SUPPORTED_IMAGE_MIME_TYPES } from '@/lib/const'
import { getCustomerServiceShop } from '@/lib/customer-service'
import { getSessionAvatar, getSessionName, isCustomerServiceSession } from '@/lib/message-utils'

import { enforceHttps } from '@/utils/enforceHttps'
import { isMacOS } from '@/utils/platform'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu'
import { Spinner } from '@/components/ui/spinner'
import { toastManager } from '@/components/ui/toast'

import { getDraftKey, useDrafts } from '@/stores/useDrafts'
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
  onToggleSticky: (session: BilibiliSession, pinned: boolean) => Promise<boolean>
  /** The chats 客服消息 holds, and the one it's showing */
  customerServiceSessions: CustomerServiceSession[]
  activeCustomerService: CustomerServiceSession | null
  onSelectCustomerService: (shop: CustomerServiceShop) => void
  onCustomerServiceReply: (reply: CustomerServiceReply) => Promise<boolean>
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
  onToggleSticky,
  customerServiceSessions,
  activeCustomerService,
  onSelectCustomerService,
  onCustomerServiceReply,
}: MessagesPanelProps) {
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
          onToggleSticky={onToggleSticky}
          customerServiceSessions={customerServiceSessions}
          activeCustomerService={activeCustomerService}
          onSelectCustomerService={onSelectCustomerService}
          onCustomerServiceReply={onCustomerServiceReply}
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
  onToggleSticky: (session: BilibiliSession, pinned: boolean) => Promise<boolean>
  customerServiceSessions: CustomerServiceSession[]
  activeCustomerService: CustomerServiceSession | null
  onSelectCustomerService: (shop: CustomerServiceShop) => void
  onCustomerServiceReply: (reply: CustomerServiceReply) => Promise<boolean>
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
  onToggleSticky,
  customerServiceSessions,
  activeCustomerService,
  onSelectCustomerService,
  onCustomerServiceReply,
}: ChatViewProps) {
  const isCustomerService = isCustomerServiceSession(session)
  // 客服消息 is shown as the customer service chat it's on
  const customerServiceTalker = isCustomerService ? activeCustomerService?.talker_info : undefined
  const avatar = customerServiceTalker?.pic_url || getSessionAvatar(session, userCache)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [droppedFile, setDroppedFile] = useState<File | null>(null)
  const dragCounterRef = useRef(0)

  const sessionName = customerServiceTalker?.name || getSessionName(session, userCache)
  // Each customer service chat keeps a draft of its own, as each conversation does
  const sessionDraftKey = getDraftKey(userInfo?.mid ?? 0, session)
  const draftKey =
    isCustomerService && activeCustomerService
      ? getDraftKey(userInfo?.mid ?? 0, session, getCustomerServiceShop(activeCustomerService))
      : sessionDraftKey
  const isDnd = session.is_dnd === 1
  const isSticky = session.top_ts > 0
  const badgeLabel = isCustomerService ? activeCustomerService?.tag_name : session.is_follow === 1 ? '关注中' : null

  const copyUsername = useCallback(() => {
    navigator.clipboard.writeText(sessionName)
  }, [sessionName])

  const copyUid = useCallback(() => {
    navigator.clipboard.writeText(String(session.talker_id))
  }, [session.talker_id])

  const handleToggleDnd = useCallback(() => {
    onToggleDnd(session, !isDnd)
  }, [session, isDnd, onToggleDnd])

  const handleToggleSticky = useCallback(() => {
    onToggleSticky(session, !isSticky)
  }, [session, isSticky, onToggleSticky])

  // Reset state when session changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset state when session changes
  useEffect(() => {
    setDroppedFile(null)
    setIsDragging(false)
    dragCounterRef.current = 0
  }, [session.talker_id])

  // Text typed before 客服消息 had a chat to show is for the chat it then shows
  useEffect(() => {
    if (draftKey === sessionDraftKey) return
    const { drafts, setDraft } = useDrafts.getState()
    const typed = drafts[sessionDraftKey]
    if (typed && !drafts[draftKey]) {
      setDraft(draftKey, typed)
      setDraft(sessionDraftKey, '')
    }
  }, [draftKey, sessionDraftKey])

  const scrollToBottom = useCallback(() => {
    if (messages.length > 0) {
      virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: 'smooth' })
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
          <div className='flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-background/80 px-12 py-8'>
            <ImagePlus className='size-12 text-primary' aria-hidden='true' />
            <span className='text-lg font-medium text-primary'>松开以发送图片</span>
          </div>
        </div>
      )}

      {/* Chat Header */}
      <div
        className={`app-region-drag flex flex-none items-center gap-3 border-b border-border/50 bg-white/80 px-4 py-3 backdrop-blur-xl select-none dark:bg-zinc-900/80 ${isMacOS ? 'pt-11' : ''}`}
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
          {isCustomerService ? (
            <CustomerServiceTitle
              name={sessionName}
              sessions={customerServiceSessions}
              active={activeCustomerService}
              onSelect={onSelectCustomerService}
            />
          ) : (
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
          )}
          <div className='flex items-center gap-2'>
            {badgeLabel && (
              <Badge variant='outline' size='sm'>
                {badgeLabel}
              </Badge>
            )}
            <span className='text-xs text-muted-foreground'>{messages.length || '-'} 条消息</span>
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
            <MenuItem onClick={handleToggleSticky}>
              {isSticky ? (
                <PinOff className='size-4' aria-hidden='true' />
              ) : (
                <Pin className='size-4' aria-hidden='true' />
              )}
              {isSticky ? '取消置顶' : '置顶'}
            </MenuItem>
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
            {!isCustomerService && (
              <MenuItem onClick={copyUid}>
                <Copy className='size-4' aria-hidden='true' />
                {`复制 UID:${session.talker_id}`}
              </MenuItem>
            )}
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
          virtuosoRef={virtuosoRef}
          messages={messages}
          emojiInfoMap={emojiInfoMap}
          session={session}
          userCache={userCache}
          userInfo={userInfo}
          // Customer service has no recall, and only its bot offers choices to pick
          onRecall={isCustomerService ? undefined : onRecall}
          onCustomerServiceReply={isCustomerService ? onCustomerServiceReply : undefined}
        />
      )}

      {/* Message Input - isolated component to prevent re-renders of messages */}
      <MessageInput
        draftKey={draftKey}
        sendingMessage={sendingMessage}
        droppedFile={droppedFile}
        onSendMessage={onSendMessage}
        onSendImage={onSendImage}
        onMessageSent={scrollToBottom}
        onDroppedFileProcessed={handleDroppedFileProcessed}
      />
    </div>
  )
}

// The customer service chat 客服消息 is on, with a menu to switch when it holds several
function CustomerServiceTitle({
  name,
  sessions,
  active,
  onSelect,
}: {
  name: string
  sessions: CustomerServiceSession[]
  active: CustomerServiceSession | null
  onSelect: (shop: CustomerServiceShop) => void
}) {
  if (sessions.length < 2) {
    return <h3 className='font-semibold'>{name}</h3>
  }

  const keyOf = (session: CustomerServiceSession) =>
    `${session.talker_info.shop_father_id}_${session.talker_info.shop_id}`

  return (
    <Menu>
      <MenuTrigger
        className='app-region-no-drag inline-flex items-center gap-1 font-semibold transition-colors hover:text-foreground/80'
        aria-label='切换客服会话'
      >
        {name}
        <ChevronDown className='size-4 text-muted-foreground' aria-hidden='true' />
      </MenuTrigger>
      <MenuPopup align='start'>
        <MenuRadioGroup
          value={active ? keyOf(active) : ''}
          onValueChange={value => {
            const session = sessions.find(s => keyOf(s) === value)
            if (session) onSelect(getCustomerServiceShop(session))
          }}
        >
          {sessions.map(session => {
            const unread = session.unread_info?.unread_count ?? 0
            return (
              <MenuRadioItem key={keyOf(session)} value={keyOf(session)} closeOnClick>
                <span className='flex min-w-0 items-center gap-2'>
                  <span className='truncate'>{session.talker_info.name}</span>
                  {unread > 0 && (
                    <Badge variant='destructive' size='sm' className='flex-none'>
                      {unread > 99 ? '99+' : unread}
                    </Badge>
                  )}
                </span>
              </MenuRadioItem>
            )
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
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
        <p className='text-lg font-medium'>选择一个会话开始聊天</p>
        <p className='text-sm'>从左侧列表中选择一个会话查看消息</p>
      </div>
    </>
  )
}
