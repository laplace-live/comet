import { useCallback, useEffect, useRef, useState } from 'react'

import type { StoredAccountInfo } from '@/types/electron'

import { QR_CODE_STATUS } from '@/types/bilibili'

export type LoginStatus = 'loading' | 'waiting_scan' | 'waiting_confirm' | 'success' | 'expired' | 'error' | 'wrong_account'

export interface UseQRCodeLoginOptions {
  /** Called when login succeeds */
  onSuccess: () => void
  /** When set, indicates re-authentication mode for an expired account */
  reauthAccount?: StoredAccountInfo | null
  /** Whether the QR login flow is active (e.g., dialog is open). Defaults to true. */
  enabled?: boolean
}

export interface UseQRCodeLoginResult {
  qrImageUrl: string | null
  status: LoginStatus
  error: string | null
  /** For reauth mode: the name of the wrong account that was scanned */
  wrongAccountName: string | null
  /** Generate or refresh the QR code */
  generateQRCode: () => Promise<void>
  /** Whether we're in reauth mode */
  isReauthMode: boolean
  /** Get localized status text */
  getStatusText: () => string
}

export function useQRCodeLogin({
  onSuccess,
  reauthAccount,
  enabled = true,
}: UseQRCodeLoginOptions): UseQRCodeLoginResult {
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
    setWrongAccountName(null)

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

  // Generate QR code when enabled
  useEffect(() => {
    if (enabled) {
      generateQRCode()
    } else {
      // Cleanup when disabled
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
  }, [enabled, generateQRCode])

  // Start polling when we have a qrcode key
  useEffect(() => {
    if (enabled && qrcodeKey && (status === 'waiting_scan' || status === 'waiting_confirm')) {
      pollTimerRef.current = setInterval(pollQRCodeStatus, 3000)
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [enabled, qrcodeKey, status, pollQRCodeStatus])

  const getStatusText = useCallback(() => {
    switch (status) {
      case 'loading':
        return '正在生成二维码...'
      case 'waiting_scan':
        if (isReauthMode && reauthAccount) {
          return `请使用账号「${reauthAccount.uname}」扫描上方二维码`
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
  }, [status, isReauthMode, reauthAccount, wrongAccountName, error])

  return {
    qrImageUrl,
    status,
    error,
    wrongAccountName,
    generateQRCode,
    isReauthMode,
    getStatusText,
  }
}
