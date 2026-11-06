import type {
  BilibiliConfirmRefreshResponse,
  BilibiliCookieInfoResponse,
  BilibiliCookieRefreshResponse,
  BilibiliCredentials,
  CookieRefreshOptions,
  CookieRefreshStatus,
  QRLoginOptions,
  RefreshedCookies,
} from './types.ts'

import { COOKIE_REFRESH_ENDPOINTS } from './constants.ts'
import { cookieStringFromCredentials, resolveCookieCredentials } from './credentials.ts'
import { QRLoginError } from './errors.ts'
import { readAccepted, send } from './request.ts'

// ============================================================================
// Where Bilibili's web cookie refresh lives (for future verification & sync)
//
// 1. Entry & check (`COOKIE_REFRESH_ENDPOINTS.INFO` -> `correspondPath`):
//    - https://s1.hdslb.com/bfs/seed/laputa-header/bili-header.umd.js
//    - https://s1.hdslb.com/bfs/seed/jinkela/header-v2/header.js (`checkAccountTokenNeedRefresh`)
//    Calls GET `//passport.bilibili.com/x/passport-login/web/cookie/info?csrf=<bili_jct>`.
//    When `data.refresh` is true, loads `wasm_ras_umd.js`, hex-encodes `refresh_${data.timestamp}`,
//    calls `wasmInit.encrypt({ data, digest: "SHA256" })`, and opens an `<iframe id="header-sync-iframe">`
//    at `//www.bilibili.com/correspond/1/${correspondPath}`.
//
// 2. RSA-OAEP public key & algorithm:
//    - https://s1.hdslb.com/bfs/static/jinkela/long/wasm/wasm_ras_umd.js
//    - https://s1.hdslb.com/bfs/static/jinkela/long/wasm/wasm_rsa_encrypt_bg.wasm
//    Compiled from the Rust `rsa` crate (`rsa::oaep`, SHA-256). The 1024-bit modulus is stored as a
//    lowercase hex string in the `.wasm` rodata section right before `modulus biguint conversion failed`:
//      cb81dd8e02470656da04dd38544446e2a3412051cfe9adc6a330a5ef90228509684960970b91c3360ca29c49e1690ff8
//      fa068cb9dfc6179d1e9585cb9424e847db1ef59f33e37dd4dca8ccfb7631ee9b4a92640d00c8204300152a0ab7cd80288
//      9d3445aec69918fe6022b534912e7b095be3424dad1ba81145e969b533181f1
//    with exponent 65537 (`AQAB`). `CORRESPOND_PUBLIC_KEY_JWK.n` below is that modulus in base64url.
//    The WASM module hex-decodes `data` back into the UTF-8 bytes of `refresh_${timestamp}`, encrypts
//    with RSA-OAEP (SHA-256), and returns the 128-byte ciphertext as lowercase hex.
//
// 3. Correspond page, refresh & confirm (`COOKIE_REFRESH_ENDPOINTS.CORRESPOND` / `REFRESH` / `CONFIRM`):
//    - https://www.bilibili.com/correspond/1/{correspondPath} (requires a signed-in `SESSDATA` cookie)
//    Serves `<div id="1-name">{refresh_csrf}</div>` and an inline script that reads `ac_time_value`
//    (`refresh_token`) from `localStorage`, POSTs `csrf`, `refresh_csrf`, `source=main_web`, and
//    `refresh_token` to `/x/passport-login/web/cookie/refresh`, stores the new `data.refresh_token`,
//    and POSTs the new `csrf` (`bili_jct`) with the old `refresh_token` to
//    `/x/passport-login/web/confirm/refresh`.
//
// 4. Community reference:
//    - https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/login/cookie_refresh.md
// ============================================================================

/** Bilibili's RSA-OAEP public key (`SHA-256`) that encrypts `refresh_${timestamp}` into `correspondPath` */
const CORRESPOND_PUBLIC_KEY_JWK: JsonWebKey = {
  kty: 'RSA',
  n: 'y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE',
  e: 'AQAB',
}

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'
const REFRESH_CSRF_PATTERN = /<div\s+id=["']1-name["']\s*>([^<]+)<\/div>/i
const MISSING_REFRESH_CREDENTIALS = 'The cookies were refreshed, but Bilibili handed over incomplete credentials'

let correspondKeyPromise: Promise<CryptoKey> | undefined

function getCorrespondKey(): Promise<CryptoKey> {
  if (!correspondKeyPromise) {
    correspondKeyPromise = crypto.subtle
      .importKey('jwk', CORRESPOND_PUBLIC_KEY_JWK, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
      .catch(error => {
        correspondKeyPromise = undefined
        throw error
      })
  }
  return correspondKeyPromise
}

/**
 * Encrypt `refresh_${timestamp}` with Bilibili's RSA-OAEP public key into the lowercase hex `correspondPath`
 * segment that `/correspond/1/{correspondPath}` takes.
 */
export async function getCorrespondPath(timestamp: number): Promise<string> {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    throw new RangeError('Expected a finite millisecond timestamp')
  }
  const key = await getCorrespondKey()
  const plaintext = new TextEncoder().encode(`refresh_${timestamp}`)
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, plaintext))
  let hex = ''
  for (const byte of encrypted) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Ask Bilibili whether `credentials` are due for a cookie refresh, and get the server timestamp to sign
 * `correspondPath` with.
 */
export async function checkCookieRefresh(
  credentials: BilibiliCredentials,
  options: QRLoginOptions = {}
): Promise<CookieRefreshStatus> {
  const url = new URL(COOKIE_REFRESH_ENDPOINTS.INFO)
  url.searchParams.set('csrf', credentials.bili_jct)

  const response = await send(url.toString(), options, {
    headers: { Cookie: cookieStringFromCredentials(credentials) },
  })
  const body = await readAccepted<BilibiliCookieInfoResponse>(response)
  const refresh = body.data?.refresh
  const timestamp = body.data?.timestamp
  if (typeof refresh !== 'boolean' || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    throw new QRLoginError('response', 'Bilibili answered without cookie refresh info')
  }

  return { refresh, timestamp, response: body as BilibiliCookieInfoResponse }
}

async function fetchRefreshCsrf(
  correspondPath: string,
  cookieHeader: string,
  options: QRLoginOptions
): Promise<string> {
  const response = await send(`${COOKIE_REFRESH_ENDPOINTS.CORRESPOND}/${correspondPath}`, options, {
    headers: { Cookie: cookieHeader },
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new QRLoginError('http', `Bilibili answered HTTP ${response.status}`, { status: response.status })
  }
  const html = await response.text()
  const refreshCsrf = REFRESH_CSRF_PATTERN.exec(html)?.[1]?.trim()
  if (!refreshCsrf) {
    throw new QRLoginError('response', 'Bilibili answered without a refresh_csrf')
  }
  return refreshCsrf
}

/**
 * Renew a login's session cookies with its `refreshToken`: fetch `refresh_csrf` via `correspondPath`, exchange
 * the current cookies and `refreshToken` for new ones, and confirm the rotation so Bilibili invalidates the old
 * token.
 */
export async function refreshCookies(
  credentials: BilibiliCredentials,
  refreshToken: string,
  options: CookieRefreshOptions = {}
): Promise<RefreshedCookies> {
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new QRLoginError('credentials', 'A refresh_token is required to refresh cookies')
  }

  const { timestamp = Date.now(), ...requestOptions } = options
  const oldCookieHeader = cookieStringFromCredentials(credentials)
  const correspondPath = await getCorrespondPath(timestamp)
  const refreshCsrf = await fetchRefreshCsrf(correspondPath, oldCookieHeader, requestOptions)

  const refreshResponse = await send(COOKIE_REFRESH_ENDPOINTS.REFRESH, requestOptions, {
    method: 'POST',
    headers: {
      Cookie: oldCookieHeader,
      'Content-Type': FORM_CONTENT_TYPE,
    },
    body: new URLSearchParams({
      csrf: credentials.bili_jct,
      refresh_csrf: refreshCsrf,
      source: 'main_web',
      refresh_token: refreshToken,
    }).toString(),
  })
  const refreshBody = await readAccepted<BilibiliCookieRefreshResponse>(refreshResponse)
  const nextRefreshToken = refreshBody.data?.refresh_token
  if (typeof nextRefreshToken !== 'string' || !nextRefreshToken) {
    throw new QRLoginError('response', 'Bilibili answered without a refresh_token')
  }
  const nextCredentials = resolveCookieCredentials(refreshResponse.headers, MISSING_REFRESH_CREDENTIALS)

  try {
    const confirmResponse = await send(COOKIE_REFRESH_ENDPOINTS.CONFIRM, requestOptions, {
      method: 'POST',
      headers: {
        Cookie: cookieStringFromCredentials(nextCredentials),
        'Content-Type': FORM_CONTENT_TYPE,
      },
      body: new URLSearchParams({
        csrf: nextCredentials.bili_jct,
        refresh_token: refreshToken,
      }).toString(),
    })
    await readAccepted<BilibiliConfirmRefreshResponse>(confirmResponse)
  } catch {
    // Bilibili's refresh endpoint has already issued nextCredentials and
    // nextRefreshToken; if confirming the old token fails, keep the rotated
    // credentials so the caller does not lose the new session.
  }

  return {
    credentials: nextCredentials,
    refreshToken: nextRefreshToken,
    response: refreshBody as BilibiliCookieRefreshResponse,
  }
}
