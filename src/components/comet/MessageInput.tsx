import { Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'

export interface MessageInputProps {
  sessionId: number
  sendingMessage: boolean
  onSendMessage: (content: string) => Promise<boolean>
  onMessageSent: () => void
}

export function MessageInput({ sessionId, sendingMessage, onSendMessage, onMessageSent }: MessageInputProps) {
  const [inputValue, setInputValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Clear input when session changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: we intentionally trigger on sessionId change
  useEffect(() => {
    setInputValue('')
  }, [sessionId])

  const handleSend = async () => {
    const messageToSend = inputValue.trim()
    if (!messageToSend || sendingMessage) return

    // Clear input immediately and keep focus for typing next message
    setInputValue('')
    textareaRef.current?.focus()

    const success = await onSendMessage(messageToSend)
    if (success) {
      onMessageSent()
    } else {
      // Restore the message if sending failed
      setInputValue(messageToSend)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Send on Enter, but allow Shift+Enter for new line
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className='flex-none border-border/50 border-t bg-white/80 p-4 backdrop-blur-xl dark:bg-zinc-900/80'>
      <div className='flex items-end gap-2'>
        <Textarea
          ref={textareaRef}
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='输入消息…'
          className='field-sizing-content max-h-32 min-h-0 flex-1 resize-none break-all'
        />
        <Button size='icon' onClick={handleSend} disabled={!inputValue.trim() || sendingMessage} className='flex-none'>
          {sendingMessage ? <Spinner className='size-4' /> : <Send className='size-4' />}
        </Button>
      </div>
    </div>
  )
}
