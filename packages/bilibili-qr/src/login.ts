import type {
  BilibiliQRCodeGenerateResponse,
  BilibiliQRCodePollResponse,
  GeneratedQRCode,
  QRCodePollResult,
  QRLoginOptions,
} from './types.ts'

import { QR_CODE_STATUS, QR_LOGIN_ENDPOINTS } from './constants.ts'
import { resolveQRCodeCredentials } from './credentials.ts'
import { QRLoginError } from './errors.ts'
import { readAccepted, send } from './request.ts'

/** Issue a login QR code: show its `url` as a QR code, drawn with any QR code library, then poll its `qrcodeKey` */
export async function generateQRCode(options: QRLoginOptions = {}): Promise<GeneratedQRCode> {
  const body = await readAccepted<BilibiliQRCodeGenerateResponse>(await send(QR_LOGIN_ENDPOINTS.GENERATE, options))
  const url = body.data?.url
  const qrcodeKey = body.data?.qrcode_key
  if (typeof url !== 'string' || !url || typeof qrcodeKey !== 'string' || !qrcodeKey) {
    throw new QRLoginError('response', 'Bilibili answered without a QR code')
  }

  return { url, qrcodeKey, response: body as BilibiliQRCodeGenerateResponse }
}

/**
 * Ask how a QR code's login stands; once it's confirmed, collect its credentials. Poll again only after the previous
 * poll has answered: a successful poll can consume the QR key, so overlapping requests must never race it.
 */
export async function pollQRCode(qrcodeKey: string, options: QRLoginOptions = {}): Promise<QRCodePollResult> {
  const url = new URL(QR_LOGIN_ENDPOINTS.POLL)
  url.searchParams.set('qrcode_key', qrcodeKey)

  const response = await send(url.toString(), options)
  const body = await readAccepted<BilibiliQRCodePollResponse>(response)
  const state = body.data
  if (typeof state?.code !== 'number') {
    throw new QRLoginError('response', 'Bilibili answered without a login state')
  }

  const received = body as BilibiliQRCodePollResponse
  switch (state.code) {
    case QR_CODE_STATUS.SUCCESS:
      return {
        status: 'success',
        credentials: await resolveQRCodeCredentials(state.url, response.headers, options),
        refreshToken: state.refresh_token ?? '',
        response: received,
      }
    case QR_CODE_STATUS.WAITING_SCAN:
      return { status: 'waiting_scan', response: received }
    case QR_CODE_STATUS.WAITING_CONFIRM:
      return { status: 'waiting_confirm', response: received }
    case QR_CODE_STATUS.EXPIRED:
      return { status: 'expired', response: received }
    default:
      return { status: 'unknown', response: received }
  }
}
