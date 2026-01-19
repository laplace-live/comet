import { ImagePlus, Send } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'

const MAX_MESSAGE_LENGTH = 1000

export interface ImageToSend {
  file: File
  dataUrl: string // Full data URL for preview (data:image/...;base64,...)
  base64Data: string // Just the base64 part for uploading
  mimeType: string
}

export interface MessageInputProps {
  sessionId: number
  sendingMessage: boolean
  onSendMessage: (content: string) => Promise<boolean>
  onSendImage: (imageData: string, mimeType: string) => Promise<boolean>
  onMessageSent: () => void
}

export function MessageInput({
  sessionId,
  sendingMessage,
  onSendMessage,
  onSendImage,
  onMessageSent,
}: MessageInputProps) {
  const [inputValue, setInputValue] = useState('')
  const [pendingImage, setPendingImage] = useState<ImageToSend | null>(null)
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [isSendingImage, setIsSendingImage] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Ref to synchronously track if we're processing an image (prevents race conditions)
  const isProcessingImageRef = useRef(false)

  const clearPendingImage = useCallback(() => {
    setPendingImage(null)
    setIsPreviewOpen(false)
    isProcessingImageRef.current = false
  }, [])

  const processImageFile = useCallback((file: File) => {
    // Prevent concurrent processing (synchronous check via ref)
    if (isProcessingImageRef.current) return
    isProcessingImageRef.current = true

    // Validate file type
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
    if (!validTypes.includes(file.type)) {
      console.error('Invalid image type:', file.type)
      isProcessingImageRef.current = false
      return
    }

    // Validate file size (max 20MB)
    const maxSize = 20 * 1024 * 1024
    if (file.size > maxSize) {
      console.error('Image too large:', file.size)
      isProcessingImageRef.current = false
      return
    }

    // Read file as data URL (base64)
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      // Extract just the base64 part for uploading
      const base64Data = dataUrl.split(',')[1]

      setPendingImage({
        file,
        dataUrl, // Use data URL directly for preview (works in Electron)
        base64Data,
        mimeType: file.type,
      })
      // Open the preview dialog
      setIsPreviewOpen(true)
      // Keep processing flag true until dialog is closed
    }
    reader.onerror = () => {
      console.error('Failed to read image file')
      isProcessingImageRef.current = false
    }
    reader.readAsDataURL(file)
  }, [])

  // Clear input when session changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: we intentionally trigger on sessionId change
  useEffect(() => {
    setInputValue('')
    clearPendingImage()
  }, [sessionId])

  // Global paste listener - works even when textarea is not focused
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      // Skip if already handled by React handler (e.g., textarea's onPaste)
      if (e.defaultPrevented) return
      // Don't handle if already sending or if dialog is open
      if (isSendingImage || isPreviewOpen) return

      const items = e.clipboardData?.items
      if (!items) return

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (file) {
            processImageFile(file)
          }
          break
        }
      }
    }

    document.addEventListener('paste', handleGlobalPaste)
    return () => {
      document.removeEventListener('paste', handleGlobalPaste)
    }
  }, [isSendingImage, isPreviewOpen, processImageFile])

  const handleSendImage = async () => {
    if (!pendingImage || isSendingImage) return

    setIsSendingImage(true)
    try {
      const success = await onSendImage(pendingImage.base64Data, pendingImage.mimeType)
      clearPendingImage()
      if (success) {
        onMessageSent()
      }
    } finally {
      setIsSendingImage(false)
    }
  }

  const handleSendText = async () => {
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
      handleSendText()
    }
  }

  const handleImageSelect = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Reset the input so the same file can be selected again
    e.target.value = ''

    processImageFile(file)
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) {
          processImageFile(file)
        }
        break
      }
    }
  }

  const handlePreviewClose = (open: boolean) => {
    if (!open && !isSendingImage) {
      clearPendingImage()
    }
  }

  return (
    <>
      {/* Image Preview Dialog */}
      <Dialog open={isPreviewOpen} onOpenChange={handlePreviewClose}>
        <DialogContent className='max-w-lg'>
          <DialogHeader>
            <DialogTitle>即将发送图片</DialogTitle>
          </DialogHeader>
          <div className='flex items-center justify-center px-6 py-4'>
            {pendingImage && (
              <img
                src={pendingImage.dataUrl}
                alt='待发送图片预览'
                className='max-h-80 max-w-full rounded-lg object-contain'
              />
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant='outline' disabled={isSendingImage} />}>取消</DialogClose>
            <Button onClick={handleSendImage} disabled={isSendingImage}>
              {isSendingImage ? (
                <>
                  <Spinner className='mr-2 size-4' />
                  发送中…
                </>
              ) : (
                <>
                  <Send className='mr-2 size-4' />
                  发送
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Message Input Area */}
      <div className='flex-none border-border/50 border-t bg-white/80 p-4 backdrop-blur-xl dark:bg-zinc-900/80'>
        <div className='flex items-end gap-2'>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type='file'
            accept='image/jpeg,image/jpg,image/png,image/gif,image/webp'
            onChange={handleFileChange}
            className='hidden'
          />

          <InputGroup>
            <InputGroupTextarea
              ref={textareaRef}
              value={inputValue}
              onChange={e => setInputValue(e.target.value.slice(0, MAX_MESSAGE_LENGTH))}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder='输入消息…'
              maxLength={MAX_MESSAGE_LENGTH}
              className='field-sizing-content max-h-32 min-h-0 flex-1 resize-none break-all'
            />
            <InputGroupAddon align={'block-end'}>
              {/* Image picker button */}
              <Button
                size='icon'
                variant='ghost'
                onClick={handleImageSelect}
                disabled={sendingMessage}
                title='发送图片'
              >
                <ImagePlus className='size-4' />
              </Button>
              {/* Character counter */}
              <span
                className={cn(
                  'ml-auto text-xs tabular-nums transition-colors',
                  inputValue.length === 0
                    ? 'text-transparent'
                    : inputValue.length >= MAX_MESSAGE_LENGTH
                      ? 'text-destructive'
                      : inputValue.length >= MAX_MESSAGE_LENGTH * 0.8
                        ? 'text-amber-500'
                        : 'text-muted-foreground'
                )}
              >
                {inputValue.length}/{MAX_MESSAGE_LENGTH}
              </span>
              <Button size='icon' onClick={handleSendText} disabled={!inputValue.trim() || sendingMessage}>
                {sendingMessage ? <Spinner className='size-4' /> : <Send className='size-4' />}
              </Button>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </div>
    </>
  )
}
