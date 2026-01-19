import { HelpCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { QR_CODE_STATUS } from '@/types/bilibili'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'

import appIcon from '@/assets/icon.png'

interface LoginScreenProps {
  onLoginSuccess: () => void
}

type LoginStatus = 'loading' | 'waiting_scan' | 'waiting_confirm' | 'success' | 'expired' | 'error'

export function LoginScreen({ onLoginSuccess }: LoginScreenProps) {
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null)
  const [qrcodeKey, setQrcodeKey] = useState<string | null>(null)
  const [status, setStatus] = useState<LoginStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const generateQRCode = useCallback(async () => {
    setStatus('loading')
    setError(null)

    try {
      const result = await window.electronAPI.bilibili.qrGenerate()

      if (result.error || !result.qrImageUrl || !result.data?.qrcode_key) {
        setError(result.error || 'Failed to generate QR code')
        setStatus('error')
        return
      }

      setQrImageUrl(result.qrImageUrl)
      setQrcodeKey(result.data.qrcode_key)
      setStatus('waiting_scan')
    } catch {
      setError('Failed to generate QR code')
      setStatus('error')
    }
  }, [])

  const pollQRCodeStatus = useCallback(async () => {
    if (!qrcodeKey) return

    try {
      const result = await window.electronAPI.bilibili.qrPoll({ qrcodeKey })

      if (result.error) {
        setError(result.error)
        setStatus('error')
        return
      }

      const code = result.data?.code

      switch (code) {
        case QR_CODE_STATUS.SUCCESS:
          setStatus('success')
          // Clear the poll timer
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current)
            pollTimerRef.current = null
          }
          // Notify parent of successful login
          onLoginSuccess()
          break
        case QR_CODE_STATUS.WAITING_SCAN:
          setStatus('waiting_scan')
          break
        case QR_CODE_STATUS.WAITING_CONFIRM:
          setStatus('waiting_confirm')
          break
        case QR_CODE_STATUS.EXPIRED:
          setStatus('expired')
          // Clear the poll timer
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current)
            pollTimerRef.current = null
          }
          break
        default:
          // Unknown status
          break
      }
    } catch (err) {
      console.error('Failed to poll QR code status:', err)
    }
  }, [qrcodeKey, onLoginSuccess])

  // Generate QR code on mount
  useEffect(() => {
    generateQRCode()

    return () => {
      // Cleanup poll timer on unmount
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [generateQRCode])

  // Start polling when we have a qrcode key
  // Continue polling during both 'waiting_scan' and 'waiting_confirm' states
  useEffect(() => {
    if (qrcodeKey && (status === 'waiting_scan' || status === 'waiting_confirm')) {
      // Poll every 3 seconds
      pollTimerRef.current = setInterval(pollQRCodeStatus, 3000)
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [qrcodeKey, status, pollQRCodeStatus])

  const getStatusText = () => {
    switch (status) {
      case 'loading':
        return '正在生成二维码...'
      case 'waiting_scan':
        return '请使用「哔哩哔哩」手机 App 扫描上方二维码'
      case 'waiting_confirm':
        return '扫描成功，请在手机上点击确认登录'
      case 'success':
        return '登录成功！'
      case 'expired':
        return '二维码已过期，请刷新重试'
      case 'error':
        return error || '发生错误'
      default:
        return ''
    }
  }

  const isMacOS = window.electronAPI?.platform === 'darwin'

  return (
    <div className='flex flex-1 flex-col'>
      {/* Draggable title bar area - only needed on macOS for traffic lights */}
      {isMacOS && <div className='app-region-drag h-8 flex-none' />}

      <div className='flex flex-1 items-center justify-center p-8'>
        <div className='w-full max-w-md space-y-3'>
          <div className='select-none text-center'>
            <img src={appIcon} alt='LAPLACE Comet' className='mx-auto mb-2 size-20' />
            <h1 className='font-bold text-2xl tracking-tight'>LAPLACE Comet</h1>
            <Tooltip>
              <TooltipTrigger className='mx-auto flex cursor-help items-center gap-1 text-base text-muted-foreground tracking-tight'>
                隐私优先的哔哩哔哩私信管理器
                <HelpCircle className='size-4' />
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
            {/* QR Code Display */}
            <div className='relative flex size-48 items-center justify-center rounded-xl bg-white p-2 shadow-lg'>
              {status === 'loading' ? (
                <Spinner className='size-8' />
              ) : qrImageUrl ? (
                <>
                  <img
                    src={qrImageUrl}
                    alt='Login QR Code'
                    className={`size-full ${status === 'expired' ? 'opacity-30 blur-sm' : ''}`}
                  />
                  {status === 'expired' && (
                    <div className='absolute inset-0 flex items-center justify-center'>
                      <Button variant='outline' size='sm' className='gap-2' onClick={generateQRCode}>
                        <RefreshCw className='size-4' />
                        刷新二维码
                      </Button>
                    </div>
                  )}
                  {status === 'waiting_confirm' && (
                    <div className='absolute inset-0 flex items-center justify-center bg-white/80'>
                      <div className='text-center'>
                        <Spinner className='mx-auto size-8' />
                        <p className='mt-2 text-sm'>等待确认…</p>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className='text-center text-muted-foreground text-sm'>{error || 'Failed to load QR code'}</div>
              )}
            </div>

            {/* Refresh button when error */}
            {status === 'error' && (
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

            <p className='select-none text-muted-foreground text-sm'>{getStatusText()}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
