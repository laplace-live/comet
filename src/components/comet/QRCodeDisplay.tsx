import { RefreshCw } from 'lucide-react'

import type { LoginStatus } from '@/hooks/useQRCodeLogin'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

interface QRCodeDisplayProps {
  qrImageUrl: string | null
  status: LoginStatus
  error: string | null
  onRefresh: () => void
}

export function QRCodeDisplay({ qrImageUrl, status, error, onRefresh }: QRCodeDisplayProps) {
  return (
    <div className='relative flex size-48 items-center justify-center rounded-xl bg-white p-2 shadow-lg'>
      {status === 'loading' ? (
        <Spinner className='size-8' aria-hidden='true' />
      ) : qrImageUrl ? (
        <>
          <img
            src={qrImageUrl}
            alt='Login QR Code'
            width={176}
            height={176}
            draggable={false}
            className={`size-full select-none ${status === 'expired' ? 'opacity-30 blur-sm' : ''}`}
          />
          {status === 'expired' && (
            <div className='absolute inset-0 flex items-center justify-center'>
              <Button variant='outline' size='sm' className='gap-2' onClick={onRefresh}>
                <RefreshCw className='size-4' />
                刷新二维码
              </Button>
            </div>
          )}
          {status === 'waiting_confirm' && (
            <div className='absolute inset-0 flex items-center justify-center bg-white/80'>
              <div className='text-center'>
                <Spinner className='mx-auto size-8' aria-hidden='true' />
                <p className='mt-2 text-sm'>等待确认…</p>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className='text-center text-muted-foreground text-sm'>{error || 'Failed to load QR code'}</div>
      )}
    </div>
  )
}
