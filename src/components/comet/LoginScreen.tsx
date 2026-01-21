import { HelpCircle, RefreshCw } from 'lucide-react'

import { isMacOS } from '@/utils/platform'

import { useQRCodeLogin } from '@/hooks/useQRCodeLogin'

import { QRCodeDisplay } from '@/components/comet/QRCodeDisplay'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'

import appLogo from '@/assets/logo.svg'

interface LoginScreenProps {
  onLoginSuccess: () => void
}

export function LoginScreen({ onLoginSuccess }: LoginScreenProps) {
  const { qrImageUrl, status, error, generateQRCode, getStatusText } = useQRCodeLogin({
    onSuccess: onLoginSuccess,
  })

  return (
    <div className='flex flex-1 flex-col'>
      {/* Draggable title bar area - only needed on macOS for traffic lights */}
      {isMacOS && <div className='app-region-drag h-8 flex-none' />}

      <div className='flex flex-1 items-center justify-center p-8'>
        <div className='w-full max-w-md space-y-3'>
          <div className='select-none text-center'>
            <img src={appLogo} alt='LAPLACE Comet' width={80} height={80} className='mx-auto mb-2 size-20' />
            <h1 className='font-bold font-logo text-3xl tracking-tight'>LAPLACE Comet</h1>
            <Tooltip>
              <TooltipTrigger className='mx-auto flex cursor-help items-center gap-1 text-base text-muted-foreground tracking-tight'>
                隐私优先的哔哩哔哩私信管理器
                <HelpCircle className='size-4' aria-hidden='true' />
              </TooltipTrigger>
              <TooltipPopup className='max-w-xs'>
                <ul className='space-y-1 text-left'>
                  <li>
                    <strong>仅本地存储</strong> - 所有凭证和数据均存储在您的本地设备上
                  </li>
                  <li>
                    <strong>系统级加密</strong> - 敏感凭证使用操作系统的安全存储加密
                  </li>
                  <li>
                    <strong>无数据追踪</strong> - 应用不会收集或传输任何使用数据
                  </li>
                  <li>
                    <strong>代码签名</strong> - 应用程序均已签名并经过公证
                  </li>
                </ul>
              </TooltipPopup>
            </Tooltip>
          </div>

          <div className='flex flex-col items-center space-y-4'>
            <QRCodeDisplay qrImageUrl={qrImageUrl} status={status} error={error} onRefresh={generateQRCode} />

            {/* Refresh button when error */}
            {status === 'error' && (
              <Button variant='outline' className='gap-2' onClick={generateQRCode}>
                <RefreshCw className='size-4' />
                重试
              </Button>
            )}

            <p className='flex select-none items-center justify-center gap-2 text-muted-foreground text-sm'>
              {status === 'waiting_scan' && (
                <span className='relative flex size-2'>
                  <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-75' />
                  <span className='relative inline-flex size-2 rounded-full bg-amber-500' />
                </span>
              )}
              {getStatusText()}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
