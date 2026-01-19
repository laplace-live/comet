import { ArrowLeft, Check, Copy, MessageSquare, User, Users } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { EmojiInfoMap } from '@/hooks/usePrivateMessages'
import type { UserCache } from '@/lib/message-utils'
import type { BilibiliMessage, BilibiliSession } from '@/types/bilibili'
import type { CheckLoginResult } from '@/types/electron'

import { SESSION_TYPE } from '@/types/bilibili'

import { getSessionAvatar, getSessionName } from '@/lib/message-utils'

import { enforceHttps } from '@/utils/enforceHttps'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'

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
}: MessagesPanelProps) {
  return (
    <div
      className={`flex flex-1 flex-col bg-linear-to-b from-white to-zinc-50/80 dark:from-zinc-900 dark:to-zinc-950/80 ${isVisible ? 'flex' : 'hidden md:flex'}`}
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
}: ChatViewProps) {
  const isMacOS = window.electronAPI?.platform === 'darwin'
  const avatar = getSessionAvatar(session, userCache)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  const copyUid = useCallback(() => {
    navigator.clipboard.writeText(String(session.talker_id))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [session.talker_id])

  // Reset copied state when session changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset state when session changes
  useEffect(() => {
    setCopied(false)
  }, [session.talker_id])

  // Auto-scroll to bottom when messages load or session changes
  // Using useEffect with requestAnimationFrame to ensure DOM is fully laid out
  useEffect(() => {
    if (!messagesLoading && messages.length > 0) {
      // Use requestAnimationFrame to wait for layout calculation to complete
      // This ensures the ScrollArea viewport is properly sized before scrolling
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
      })
    }
  }, [messagesLoading, messages])

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    })
  }, [])

  return (
    <>
      {/* Chat Header */}
      <div
        className={`app-region-drag flex flex-none items-center gap-3 border-border/50 border-b bg-white/80 px-4 py-3 backdrop-blur-xl dark:bg-zinc-900/80 ${isMacOS ? 'pt-11' : ''}`}
      >
        <Button variant='ghost' size='icon' className='app-region-no-drag md:hidden' onClick={onBack}>
          <ArrowLeft />
        </Button>

        <Avatar className='size-10 ring-2 ring-border/50'>
          {avatar && <AvatarImage src={enforceHttps(avatar)} />}
          <AvatarFallback className='bg-linear-to-br from-pink-400 to-orange-300 text-white'>
            {session.session_type === SESSION_TYPE.FAN_GROUP ? (
              <Users className='size-4' />
            ) : (
              <User className='size-4' />
            )}
          </AvatarFallback>
        </Avatar>

        <div className='flex-1'>
          <h3 className='flex items-center gap-1.5 font-semibold'>
            <a
              href={`https://space.bilibili.com/${session.talker_id}`}
              target='_blank'
              rel='noopener noreferrer'
              className='app-region-no-drag'
            >
              {getSessionName(session, userCache)}
            </a>
            <Tooltip>
              <TooltipTrigger
                onClick={copyUid}
                className='app-region-no-drag inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-800'
              >
                {copied ? <Check className='size-3.5 text-emerald-500' /> : <Copy className='size-3.5' />}
              </TooltipTrigger>
              <TooltipPopup>{copied ? '已复制' : `复制 UID: ${session.talker_id}`}</TooltipPopup>
            </Tooltip>
          </h3>
          <div className='flex items-center gap-2'>
            {session.live_status === 1 && (
              <Badge variant='error' size='sm'>
                直播中
              </Badge>
            )}
            <span className='text-muted-foreground text-xs'>{messages.length || '-'} 条消息</span>
          </div>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className='flex-1'>
        <div className='p-4'>
          {messagesLoading ? (
            <div className='flex items-center justify-center py-16'>
              <Spinner className='size-8 text-muted-foreground' />
            </div>
          ) : messages.length === 0 ? (
            <div className='flex flex-col items-center justify-center py-16 text-muted-foreground'>
              <MessageSquare className='mb-4 size-12 opacity-50' />
              <p>暂无消息</p>
            </div>
          ) : (
            <MessagesList
              messages={messages}
              emojiInfoMap={emojiInfoMap}
              session={session}
              userCache={userCache}
              userInfo={userInfo}
            />
          )}
          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      {/* Message Input - isolated component to prevent re-renders of messages */}
      <MessageInput
        sessionId={session.talker_id}
        sendingMessage={sendingMessage}
        onSendMessage={onSendMessage}
        onSendImage={onSendImage}
        onMessageSent={scrollToBottom}
      />
    </>
  )
}

function EmptyState() {
  const isMacOS = window.electronAPI?.platform === 'darwin'

  return (
    <>
      {/* Draggable title bar area - only needed on macOS for traffic lights */}
      {isMacOS && <div className='app-region-drag h-8 flex-none' />}
      <div className='flex flex-1 flex-col items-center justify-center text-muted-foreground'>
        <div className='mb-6 flex size-24 items-center justify-center rounded-3xl bg-linear-to-br from-zinc-100 to-zinc-200 dark:from-zinc-800 dark:to-zinc-900'>
          <MessageSquare className='size-12 opacity-50' />
        </div>
        <p className='font-medium text-lg'>选择一个会话开始聊天</p>
        <p className='text-sm'>从左侧列表中选择一个会话查看消息</p>
      </div>
    </>
  )
}
