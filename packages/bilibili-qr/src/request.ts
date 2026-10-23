import type { QRLoginOptions } from './types.ts'

import { DEFAULT_HEADERS } from './constants.ts'
import { QRLoginError } from './errors.ts'

/** Send one login request with the caller's headers, signal and fetch */
export function send(
  url: string | URL,
  { fetch: request = fetch, headers = DEFAULT_HEADERS, signal }: QRLoginOptions,
  init: { headers?: Record<string, string>; redirect?: RequestRedirect } = {}
): Promise<Response> {
  return request(url, { ...init, headers: mergeHeaders(headers, init.headers), signal })
}

/**
 * The headers in order, each name replacing any earlier one. Header names ignore case, so `referer` and `Referer`
 * are one header: kept apart, fetch would send both values joined into one.
 */
function mergeHeaders(...sources: Array<Readonly<Record<string, string>> | undefined>): Record<string, string> {
  const merged = new Map<string, [string, string]>()
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) merged.set(name.toLowerCase(), [name, value])
  }
  return Object.fromEntries(merged.values())
}

/**
 * Bilibili's JSON response once it accepted the request. An HTTP error, an answer that isn't JSON, and a refusal
 * throw a `QRLoginError` instead.
 */
export async function readAccepted<T>(response: Response): Promise<Partial<T>> {
  if (!response.ok) {
    await response.body?.cancel()
    throw new QRLoginError('http', `Bilibili answered HTTP ${response.status}`, { status: response.status })
  }

  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Not as `cause`: a JSON parse error quotes the text around its position, which can be a login
    throw new QRLoginError('response', 'Bilibili answered with something other than JSON')
  }

  if (typeof body !== 'object' || body === null || !('code' in body) || typeof body.code !== 'number') {
    throw new QRLoginError('response', 'Bilibili answered without a response code')
  }
  if (body.code !== 0) {
    const apiMessage = 'message' in body && typeof body.message === 'string' ? body.message : ''
    throw new QRLoginError('api', apiMessage || `Bilibili refused the request with code ${body.code}`, {
      code: body.code,
      apiMessage,
    })
  }
  return body as Partial<T>
}
