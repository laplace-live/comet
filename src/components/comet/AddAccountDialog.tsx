import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { StoredAccountInfo } from '@/types/electron'

import { QR_CODE_STATUS } from '@/types/bilibili'

import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  // When set, indicates re-authentication mode for an expired account
  reauthAccount?: StoredAccountInfo | null
}

type LoginStatus = 'loading' | 'waiting_scan' | 'waiting_confirm' | 'success' | 'expired' | 'error' | 'wrong_account'

export function AddAccountDialog({ open, onOpenChange, onSuccess, reauthAccount }: AddAccountDialogProps) {
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null)
  const [qrcodeKey, setQrcodeKey] = useState<string | null>(null)
  const [status, setStatus] = useState<LoginStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [wrongAccountName, setWrongAccountName] = useState<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const isReauthMode = !!reauthAccount

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
      // In reauth mode, skip auto-save so we can validate the scanned account first
      const result = await window.electronAPI.bilibili.qrPoll({ qrcodeKey, skipSave: isReauthMode })

      if (result.error) {
        setError(result.error)
        setStatus('error')
        return
      }

      const code = result.data?.code

      switch (code) {
        case QR_CODE_STATUS.SUCCESS:
          // Clear the poll timer
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current)
            pollTimerRef.current = null
          }

          if (isReauthMode && reauthAccount) {
            // Re-auth mode - verify credentials exist and account matches
            if (!result.credentials) {
              // Edge case: SUCCESS status but no credentials extracted
              setError('登录成功但无法获取凭证，请重试')
              setStatus('error')
              return
            }

            const reauthResult = await window.electronAPI.bilibili.reauthAccount({
              mid: reauthAccount.mid,
              credentials: result.credentials,
            })

            if (reauthResult.success) {
              setStatus('success')
              onSuccess()
            } else if (reauthResult.error === 'Credentials are for a different account') {
              // Wrong account scanned
              setWrongAccountName(reauthResult.userInfo?.uname || `UID:${reauthResult.actualMid}`)
              setStatus('wrong_account')
            } else {
              setError(reauthResult.error || '重新登录失败')
              setStatus('error')
            }
          } else {
            // Normal add account flow - qrPoll already saved the account
            setStatus('success')
            onSuccess()
          }
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
  }, [qrcodeKey, onSuccess, isReauthMode, reauthAccount])

  // Generate QR code when dialog opens
  useEffect(() => {
    if (open) {
      generateQRCode()
    } else {
      // Cleanup when dialog closes
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
      setQrImageUrl(null)
      setQrcodeKey(null)
      setStatus('loading')
      setError(null)
      setWrongAccountName(null)
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [open, generateQRCode])

  // Start polling when we have a qrcode key
  useEffect(() => {
    if (open && qrcodeKey && (status === 'waiting_scan' || status === 'waiting_confirm')) {
      pollTimerRef.current = setInterval(pollQRCodeStatus, 3000)
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [open, qrcodeKey, status, pollQRCodeStatus])

  const getStatusText = () => {
    switch (status) {
      case 'loading':
        return '正在生成二维码...'
      case 'waiting_scan':
        if (isReauthMode) {
          return `请使用账号「${reauthAccount?.uname}」扫描上方二维码`
        }
        return '请使用「哔哩哔哩」手机 App 扫描上方二维码'
      case 'waiting_confirm':
        return '扫描成功，请在手机上点击确认登录'
      case 'success':
        return isReauthMode ? '重新登录成功！' : '登录成功！'
      case 'expired':
        return '二维码已过期，请刷新重试'
      case 'wrong_account':
        return `请使用账号「${reauthAccount?.uname}」登录，而不是「${wrongAccountName}」`
      case 'error':
        return error || '发生错误'
      default:
        return ''
    }
  }

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

          {/* QR Code Display */}
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
