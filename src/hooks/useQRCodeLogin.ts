import { useCallback, useEffect, useRef, useState } from 'react'

import type { QRGenerateResult, StoredAccountInfo } from '@/types/electron'

import { QR_CODE_STATUS } from '@/types/bilibili'

import { LOGIN_CONFIG } from '@/lib/const'

const GENERATE_FAILED = '生成二维码失败，请重试'
const POLL_FAILED = '查询登录状态失败，请重试'
const COMPLETION_FAILED = '登录验证失败，请重试'

export type LoginStatus =
  | 'loading'
  | 'waiting_scan'
  | 'waiting_confirm'
  | 'success'
  | 'expired'
  | 'error'
  | 'wrong_account'

export interface UseQRCodeLoginOptions {
  /** Called when login succeeds */
  onSuccess: () => void | Promise<void>
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
  const [status, setStatus] = useState<LoginStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [wrongAccountName, setWrongAccountName] = useState<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generationRef = useRef(0)
  const onSuccessRef = useRef(onSuccess)

  const reauthMid = reauthAccount?.mid
  const isReauthMode = reauthMid !== undefined

  useEffect(() => {
    onSuccessRef.current = onSuccess
  }, [onSuccess])

  const resetState = useCallback(() => {
    setQrImageUrl(null)
    setStatus('loading')
    setError(null)
    setWrongAccountName(null)
  }, [])

  // Invalidates in-flight work and claims the next generation. Responses from a
  // previous QR code (or a closed dialog) must not change the current login state.
  const startGeneration = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
    return ++generationRef.current
  }, [])

  const generateQRCode = useCallback(async () => {
    if (!enabled) return

    const generation = startGeneration()
    const isCurrent = () => generationRef.current === generation
    resetState()

    const fail = (message: string) => {
      if (!isCurrent()) return
      setError(message)
      setStatus('error')
    }

    let result: QRGenerateResult | null = null
    try {
      result = await window.electronAPI.bilibili.qrGenerate()
    } catch {
      // Left null so the guard below reports it like any other failed generate.
    }
    if (!isCurrent()) return

    if (!result || result.error || result.code !== 0 || !result.qrImageUrl || !result.data?.qrcode_key) {
      fail(result?.error || result?.message || GENERATE_FAILED)
      return
    }

    const qrcodeKey = result.data.qrcode_key
    setQrImageUrl(result.qrImageUrl)
    setStatus('waiting_scan')

    const poll = async () => {
      if (!isCurrent()) return
      pollTimerRef.current = null

      try {
        const result = await window.electronAPI.bilibili.qrPoll({ qrcodeKey, skipSave: reauthMid !== undefined })
        if (!isCurrent()) return

        if (result.error || result.code !== 0) {
          fail(result.error || result.message || POLL_FAILED)
          return
        }

        switch (result.data?.code) {
          case QR_CODE_STATUS.SUCCESS: {
            if (!result.credentials) {
              fail('登录成功但无法获取凭证，请重试')
              return
            }

            if (reauthMid !== undefined) {
              const reauthResult = await window.electronAPI.bilibili.reauthAccount({
                mid: reauthMid,
                credentials: result.credentials,
              })
              if (!isCurrent()) return

              if (!reauthResult.success) {
                if (reauthResult.error === 'Credentials are for a different account') {
                  setWrongAccountName(reauthResult.userInfo?.uname || `UID:${reauthResult.actualMid}`)
                  setStatus('wrong_account')
                } else {
                  fail(reauthResult.error || '重新登录失败')
                }
                return
              }
            }

            setStatus('success')
            // Report what the completion step itself failed at. The poll handler
            // below would blame a status query that actually succeeded.
            try {
              await onSuccessRef.current()
            } catch (completionError) {
              fail(completionError instanceof Error ? completionError.message : COMPLETION_FAILED)
            }
            return
          }
          case QR_CODE_STATUS.WAITING_SCAN:
            setStatus('waiting_scan')
            break
          case QR_CODE_STATUS.WAITING_CONFIRM:
            setStatus('waiting_confirm')
            break
          case QR_CODE_STATUS.EXPIRED:
            setStatus('expired')
            return
          default:
            fail(result.data?.message || '登录状态异常，请刷新二维码重试')
            return
        }

        // Schedule only after this request finishes. A successful poll can
        // consume the QR key, so overlapping requests must never race it.
        pollTimerRef.current = setTimeout(poll, LOGIN_CONFIG.QR_POLL_INTERVAL)
      } catch {
        fail(POLL_FAILED)
      }
    }

    pollTimerRef.current = setTimeout(poll, LOGIN_CONFIG.QR_POLL_INTERVAL)
  }, [enabled, reauthMid, startGeneration, resetState])

  useEffect(() => {
    if (enabled) {
      generateQRCode()
    } else {
      resetState()
    }

    return () => {
      startGeneration()
    }
  }, [enabled, generateQRCode, startGeneration, resetState])

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
