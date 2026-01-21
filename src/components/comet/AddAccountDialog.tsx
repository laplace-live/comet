import { AlertTriangle, RefreshCw } from 'lucide-react'

import type { StoredAccountInfo } from '@/types/electron'

import { useQRCodeLogin } from '@/hooks/useQRCodeLogin'

import { QRCodeDisplay } from '@/components/comet/QRCodeDisplay'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  // When set, indicates re-authentication mode for an expired account
  reauthAccount?: StoredAccountInfo | null
}

export function AddAccountDialog({ open, onOpenChange, onSuccess, reauthAccount }: AddAccountDialogProps) {
  const { qrImageUrl, status, error, generateQRCode, isReauthMode, getStatusText } = useQRCodeLogin({
    onSuccess,
    reauthAccount,
    enabled: open,
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side='bottom' className='h-auto max-h-[80vh]'>
        <SheetHeader className='sr-only'>
          <SheetTitle>{isReauthMode ? '重新登录' : '添加账号'}</SheetTitle>
          <SheetDescription>
            {isReauthMode ? `重新登录账号「${reauthAccount?.uname}」` : '扫描二维码登录新账号'}
          </SheetDescription>
        </SheetHeader>

        <div className='flex flex-col items-center space-y-4 py-6'>
          <h2 className='select-none font-semibold text-lg'>{isReauthMode ? '重新登录' : '添加新账号'}</h2>
          {isReauthMode && reauthAccount && (
            <div className='flex items-center gap-2 text-amber-600'>
              <AlertTriangle className='size-4' aria-hidden='true' />
              <span className='text-sm'>账号「{reauthAccount.uname}」需要重新登录</span>
            </div>
          )}

          <QRCodeDisplay qrImageUrl={qrImageUrl} status={status} error={error} onRefresh={generateQRCode} />

          {/* Refresh button when error or wrong account */}
          {(status === 'error' || status === 'wrong_account') && (
            <Button variant='outline' className='gap-2' onClick={generateQRCode}>
              <RefreshCw className='size-4' />
              重试
            </Button>
          )}

          {/* Status indicator */}
          {status === 'waiting_scan' && (
            <div className='flex select-none items-center gap-2 text-muted-foreground text-sm'>
              <span className='relative flex size-2'>
                <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75' />
                <span className='relative inline-flex size-2 rounded-full bg-sky-500' />
              </span>
              等待扫描中…
            </div>
          )}

          <p className='select-none text-center text-muted-foreground text-sm'>{getStatusText()}</p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
