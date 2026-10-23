import type { BilibiliCredentials, QRLoginOptions } from './types.ts'

import { PASSPORT, QR_LOGIN_ORIGINS } from './constants.ts'
import { QRLoginError } from './errors.ts'
import { send } from './request.ts'

const COOKIE_NAMES: readonly string[] = ['SESSDATA', 'DedeUserID', 'DedeUserID__ckMd5', 'bili_jct']
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])
const TICKET_REFERER = `${PASSPORT}/`
const MISSING_CREDENTIALS = 'The login was confirmed, but Bilibili handed over incomplete credentials'

function credentialsFromCookies(cookies: Map<string, string>): BilibiliCredentials | null {
  const SESSDATA = cookies.get('SESSDATA')
  const bili_jct = cookies.get('bili_jct')
  const userId = cookies.get('DedeUserID') || ''
  const DedeUserID = Number(userId)
  if (!SESSDATA || !bili_jct || !/^\d+$/.test(userId) || !Number.isSafeInteger(DedeUserID) || DedeUserID <= 0) {
    return null
  }

  return { SESSDATA, bili_jct, DedeUserID, DedeUserID__ckMd5: cookies.get('DedeUserID__ckMd5') || undefined }
}

function collectCookies(headers: Headers, cookies: Map<string, string>): void {
  // Read individual headers: splitting on commas corrupts Expires and cookie values.
  for (const header of headers.getSetCookie()) {
    const pair = header.split(';', 1)[0] ?? ''
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    const name = pair.slice(0, separator).trim()
    if (!COOKIE_NAMES.includes(name)) continue
    try {
      cookies.set(name, decodeURIComponent(pair.slice(separator + 1)))
    } catch (cause) {
      throw new QRLoginError('credentials', MISSING_CREDENTIALS, { cause })
    }
  }
}

/** Resolve both legacy credential URLs and the newer one-use crossDomain tickets. */
export async function resolveQRCodeCredentials(
  loginUrl: string | undefined,
  headers: Headers,
  options: QRLoginOptions
): Promise<BilibiliCredentials> {
  const cookies = new Map<string, string>()
  let url: URL | undefined
  if (loginUrl) {
    try {
      url = new URL(loginUrl)
    } catch {
      // Not as `cause`: a URL parse error carries the URL, which holds the login
      throw new QRLoginError('credentials', MISSING_CREDENTIALS)
    }
    for (const name of COOKIE_NAMES) {
      const value = url.searchParams.get(name)
      // URLSearchParams already decodes the legacy query values once.
      if (value) cookies.set(name, value)
    }
  }
  collectCookies(headers, cookies)
  const credentials = credentialsFromCookies(cookies)
  if (credentials) return credentials

  // fetch keeps no cookie jar, and automatic redirects hide intermediate Set-Cookie
  // headers, so collect them at each hop. Never send a login ticket to another origin.
  for (let redirects = 0; url && redirects < 5; redirects++) {
    if (!QR_LOGIN_ORIGINS.has(url.origin) || url.username || url.password) {
      throw new QRLoginError('credentials', "The login ticket points outside Bilibili's passport")
    }
    const response = await send(url, options, { headers: { Referer: TICKET_REFERER }, redirect: 'manual' })
    // Only the headers matter: release the body before collectCookies can throw
    await response.body?.cancel()
    collectCookies(response.headers, cookies)
    const resolved = credentialsFromCookies(cookies)
    if (resolved) return resolved

    const location = response.headers.get('location')
    if (!REDIRECT_STATUSES.has(response.status) || !location) break
    try {
      url = new URL(location, url)
    } catch {
      // Not as `cause`: a URL parse error carries its base, the ticket URL
      throw new QRLoginError('credentials', "The login ticket's redirect isn't a valid URL")
    }
  }

  throw new QRLoginError('credentials', MISSING_CREDENTIALS)
}

/** The `Cookie` header that signs a request in with `credentials` */
export function cookieStringFromCredentials(credentials: BilibiliCredentials): string {
  return [
    `SESSDATA=${encodeURIComponent(credentials.SESSDATA)}`,
    `DedeUserID=${credentials.DedeUserID}`,
    credentials.DedeUserID__ckMd5 ? `DedeUserID__ckMd5=${credentials.DedeUserID__ckMd5}` : '',
    `bili_jct=${credentials.bili_jct}`,
  ]
    .filter(Boolean)
    .join('; ')
}
