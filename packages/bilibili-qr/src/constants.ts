/** Bilibili's passport, which runs QR login */
export const PASSPORT = 'https://passport.bilibili.com'

/** Bilibili's web QR login endpoints */
export const QR_LOGIN_ENDPOINTS = {
  /** Issue a QR code: the URL it encodes and the key that polls it */
  GENERATE: `${PASSPORT}/x/passport-login/web/qrcode/generate`,
  /** Poll a QR code's login state, which hands over the login once confirmed */
  POLL: `${PASSPORT}/x/passport-login/web/qrcode/poll`,
} as const

/** Allowed origins for QR login ticket exchange and redirects. */
export const QR_LOGIN_ORIGINS: ReadonlySet<string> = new Set([PASSPORT, 'https://passport.biligame.com'])

/** QR code poll status, `data.code` of the poll response */
export const QR_CODE_STATUS = {
  SUCCESS: 0,
  WAITING_SCAN: 86101,
  WAITING_CONFIRM: 86090,
  EXPIRED: 86038,
} as const

/** The app's CHROME_VERSION in src/lib/const.ts, which can't import this package; the app's tests keep them equal */
const CHROME_VERSION = '149'

/** Chrome on Windows calling Bilibili's API: the headers every request sends unless `headers` replaces them */
export const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`,
  'sec-ch-ua': `"Not(A:Brand";v="8", "Chromium";v="${CHROME_VERSION}", "Google Chrome";v="${CHROME_VERSION}"`,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
}
