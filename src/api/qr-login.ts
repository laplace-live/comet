import type { BilibiliCredentials } from '@/types/bilibili'

import { BILIBILI_API, BILIBILI_LOGIN_ORIGINS, COMMON_HEADERS } from '@/lib/const'

const COOKIE_NAMES: readonly string[] = ['SESSDATA', 'DedeUserID', 'DedeUserID__ckMd5', 'bili_jct']
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])
const TICKET_REFERER = `${BILIBILI_API.PASSPORT}/`
const MISSING_CREDENTIALS = '登录成功但无法获取完整凭证，请刷新二维码重试'

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
    const pair = header.split(';', 1)[0]
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    const name = pair.slice(0, separator).trim()
    if (!COOKIE_NAMES.includes(name)) continue
    try {
      cookies.set(name, decodeURIComponent(pair.slice(separator + 1)))
    } catch {
      throw new Error(MISSING_CREDENTIALS)
    }
  }
}

/** Resolve both legacy credential URLs and the newer one-use crossDomain tickets. */
export async function resolveQRCodeCredentials(
  loginUrl: string | undefined,
  headers: Headers,
  signal: AbortSignal
): Promise<BilibiliCredentials> {
  const cookies = new Map<string, string>()
  let url: URL | undefined
  if (loginUrl) {
    try {
      url = new URL(loginUrl)
    } catch {
      throw new Error(MISSING_CREDENTIALS)
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

  // Node fetch has no cookie jar and automatic redirects hide intermediate Set-Cookie
  // headers, so collect them at each hop. Never send a login ticket to another origin.
  for (let redirects = 0; url && redirects < 5; redirects++) {
    if (!BILIBILI_LOGIN_ORIGINS.has(url.origin) || url.username || url.password) {
      throw new Error('登录凭证地址无效，请刷新二维码重试')
    }
    const response = await fetch(url, {
      headers: { ...COMMON_HEADERS, Referer: TICKET_REFERER },
      redirect: 'manual',
      signal,
    })
    collectCookies(response.headers, cookies)
    await response.body?.cancel()
    const resolved = credentialsFromCookies(cookies)
    if (resolved) return resolved

    const location = response.headers.get('location')
    if (!REDIRECT_STATUSES.has(response.status) || !location) break
    url = new URL(location, url)
  }

  throw new Error(MISSING_CREDENTIALS)
}
