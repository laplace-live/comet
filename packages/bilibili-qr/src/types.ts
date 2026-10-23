/** A login's session cookies, decoded; `cookieStringFromCredentials` turns them back into a `Cookie` header */
export interface BilibiliCredentials {
  SESSDATA: string
  DedeUserID: number
  DedeUserID__ckMd5?: string
  /** The CSRF token Bilibili's write APIs take as `csrf` */
  bili_jct: string
}

/** Bilibili's response to `QR_LOGIN_ENDPOINTS.GENERATE` */
export interface BilibiliQRCodeGenerateResponse {
  code: number
  message: string
  ttl: number
  data: {
    url: string
    qrcode_key: string
  }
}

/** Bilibili's response to `QR_LOGIN_ENDPOINTS.POLL` */
export interface BilibiliQRCodePollResponse {
  code: number
  message: string
  ttl: number
  data: {
    url: string
    refresh_token: string
    timestamp: number
    /** The login state, one of `QR_CODE_STATUS` unless Bilibili added one */
    code: number
    message: string
  }
}

export interface QRLoginOptions {
  /** Headers for every request, in place of `DEFAULT_HEADERS`; spread those in to add to them */
  headers?: Readonly<Record<string, string>>
  /** Aborts the call, every request it makes included */
  signal?: AbortSignal
  /**
   * Sends the requests; the global `fetch` by default. Not `typeof fetch`, which a plain function can't satisfy where
   * the runtime's `fetch` has extra members, such as Bun's `fetch.preconnect`.
   */
  fetch?: (input: string | URL, init: RequestInit) => Promise<Response>
}

export interface GeneratedQRCode {
  /** What the QR code encodes: the page the Bilibili app opens when it scans the code */
  url: string
  /** The key `pollQRCode` follows the login with */
  qrcodeKey: string
  /** Bilibili's response as received */
  response: BilibiliQRCodeGenerateResponse
}

export type QRCodePollResult =
  | {
      /**
       * - `waiting_scan`: nobody has scanned the code yet
       * - `waiting_confirm`: scanned, waiting for the user to confirm the login in the app
       * - `expired`: the code no longer logs in; generate a new one
       * - `unknown`: a state this package doesn't know, in `response.data.code` and `response.data.message`
       */
      status: 'waiting_scan' | 'waiting_confirm' | 'expired' | 'unknown'
      /** Bilibili's response as received */
      response: BilibiliQRCodePollResponse
    }
  | {
      /** The user confirmed the login */
      status: 'success'
      credentials: BilibiliCredentials
      /** What Bilibili's cookie refresh takes to renew the cookies, which this package doesn't do */
      refreshToken: string
      /** Bilibili's response as received. Its `data.url` carries the login itself: never log it */
      response: BilibiliQRCodePollResponse
    }
