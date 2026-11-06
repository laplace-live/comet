import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspect } from 'node:util'

import {
  type BilibiliCredentials,
  COOKIE_REFRESH_ENDPOINTS,
  checkCookieRefresh,
  cookieStringFromCredentials,
  DEFAULT_HEADERS,
  generateQRCode,
  getCorrespondPath,
  pollQRCode,
  QR_CODE_STATUS,
  QR_LOGIN_ENDPOINTS,
  QRLoginError,
  refreshCookies,
} from '../src/index.ts'

const credentials: BilibiliCredentials = {
  SESSDATA: 'fixture-session,percent%value',
  DedeUserID: 12345,
  DedeUserID__ckMd5: 'fixture-checksum',
  bili_jct: 'fixture-csrf',
}
/** The credentials as cookie values */
const cookies: Record<string, string> = { ...credentials, DedeUserID: String(credentials.DedeUserID) }
const ticketUrl = 'https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=fixture'
const generated = {
  code: 0,
  message: '0',
  ttl: 1,
  data: {
    url: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=fixture-key',
    qrcode_key: 'fixture-key',
  },
}

type Step = Response | ((url: string, init: RequestInit) => Response | Promise<Response>)

/** A fetch that answers each request with the next step and records what was sent */
function fakeFetch(...steps: Step[]) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    calls.push({ url, init })
    const step = steps[calls.length - 1]
    assert.ok(step, `Unexpected fetch: ${url}`)
    return typeof step === 'function' ? step(url, init) : step
  }
  return { fetch, calls }
}

function legacyUrl(overrides: Record<string, string> = {}): string {
  return `https://passport.bilibili.com/login?${new URLSearchParams({ ...cookies, ...overrides })}`
}

function cookieHeaders(values: Record<string, string>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(values)) {
    headers.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; Domain=.bilibili.com; HttpOnly`)
  }
  return headers
}

function pollState(code: number, url = '') {
  return {
    code: 0,
    message: '0',
    ttl: 1,
    data: { url, refresh_token: 'fixture-refresh', timestamp: 1, code, message: '' },
  }
}

function confirmed(url: string, headers?: Headers): Response {
  return Response.json(pollState(QR_CODE_STATUS.SUCCESS, url), { headers })
}

async function login(...steps: Step[]): Promise<BilibiliCredentials> {
  const result = await pollQRCode('fixture-key', { fetch: fakeFetch(...steps).fetch })
  assert.equal(result.status, 'success')
  return result.status === 'success' ? result.credentials : assert.fail()
}

test('generateQRCode returns the URL to show and the key to poll', async () => {
  const signal = new AbortController().signal
  const { fetch, calls } = fakeFetch(Response.json(generated))
  assert.deepEqual(await generateQRCode({ fetch, signal }), {
    url: generated.data.url,
    qrcodeKey: 'fixture-key',
    response: generated,
  })
  assert.equal(calls[0]?.url, QR_LOGIN_ENDPOINTS.GENERATE)
  assert.deepEqual(calls[0]?.init.headers, DEFAULT_HEADERS)
  assert.equal(calls[0]?.init.signal, signal)
})

test('headers replace the default headers', async () => {
  const headers = { 'User-Agent': 'fixture-agent' }
  const { fetch, calls } = fakeFetch(Response.json(generated))
  await generateQRCode({ fetch, headers })
  assert.deepEqual(calls[0]?.init.headers, headers)
})

test('header names ignore case, so a later spelling replaces an earlier one instead of joining it', async () => {
  const headers = { ...DEFAULT_HEADERS, 'user-agent': 'fixture-agent', referer: 'https://www.bilibili.com/' }
  const { fetch, calls } = fakeFetch(confirmed(ticketUrl), new Response(null, { headers: cookieHeaders(cookies) }))
  await pollQRCode('fixture-key', { fetch, headers })
  const sent = calls.map(call => new Headers(call.init.headers))
  assert.deepEqual(
    sent.map(header => header.get('User-Agent')),
    ['fixture-agent', 'fixture-agent']
  )
  assert.deepEqual(
    sent.map(header => header.get('Referer')),
    ['https://www.bilibili.com/', 'https://passport.bilibili.com/']
  )
})

test('requests go through the global fetch by default', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(generated))
  await generateQRCode()
  assert.equal(fetch.mock.callCount(), 1)
})

test('an HTTP error rejects with its status', async () => {
  const { fetch } = fakeFetch(new Response('busy', { status: 503 }))
  await assert.rejects(generateQRCode({ fetch }), { name: 'QRLoginError', reason: 'http', status: 503 })
})

test("a refusal rejects with Bilibili's code and message", async () => {
  const { fetch } = fakeFetch(Response.json({ code: -412, message: '请求被拦截', ttl: 1 }))
  await assert.rejects(generateQRCode({ fetch }), {
    reason: 'api',
    code: -412,
    message: '请求被拦截',
    apiMessage: '请求被拦截',
  })
})

test('a refusal without a message names its code, keeping the empty explanation apart', async () => {
  const { fetch } = fakeFetch(Response.json({ code: -400, message: '', ttl: 1 }))
  await assert.rejects(generateQRCode({ fetch }), { reason: 'api', code: -400, message: /-400/, apiMessage: '' })
})

for (const body of ['<html>', 'null', '{}', '{"code":0}', '{"code":0,"data":{"url":"https://example.invalid/"}}']) {
  test(`generateQRCode rejects an answer it can't use: ${body}`, async () => {
    const { fetch } = fakeFetch(new Response(body))
    await assert.rejects(generateQRCode({ fetch }), { reason: 'response' })
  })
}

for (const [code, status] of [
  [QR_CODE_STATUS.WAITING_SCAN, 'waiting_scan'],
  [QR_CODE_STATUS.WAITING_CONFIRM, 'waiting_confirm'],
  [QR_CODE_STATUS.EXPIRED, 'expired'],
  [12345, 'unknown'],
] as const) {
  test(`poll state ${code} is ${status}, as received`, async () => {
    const { fetch, calls } = fakeFetch(Response.json(pollState(code)))
    assert.deepEqual(await pollQRCode('fixture-key', { fetch }), { status, response: pollState(code) })
    const url = new URL(calls[0]?.url ?? '')
    assert.equal(`${url.origin}${url.pathname}`, QR_LOGIN_ENDPOINTS.POLL)
    assert.equal(url.searchParams.get('qrcode_key'), 'fixture-key')
  })
}

for (const body of ['<html>', 'null', '{"code":0}', '{"code":0,"data":{}}']) {
  test(`pollQRCode rejects an answer without a login state: ${body}`, async () => {
    const { fetch } = fakeFetch(new Response(body))
    await assert.rejects(pollQRCode('fixture-key', { fetch }), { reason: 'response' })
  })
}

test("an answer that isn't JSON rejects without quoting it", async () => {
  // A JSON parse error quotes the text around where it failed
  const { fetch } = fakeFetch(new Response('ticket=fixture-secret'))
  await assert.rejects(pollQRCode('fixture-key', { fetch }), error => {
    assert.ok(error instanceof QRLoginError)
    assert.equal(error.reason, 'response')
    assert.ok(!inspect(error).includes('ticket='), 'the error must not carry the answer')
    return true
  })
})

test('a legacy login URL carries the credentials itself', async () => {
  const { fetch, calls } = fakeFetch(confirmed(legacyUrl()))
  const result = await pollQRCode('fixture-key', { fetch })
  assert.deepEqual(result, {
    status: 'success',
    credentials,
    refreshToken: 'fixture-refresh',
    response: pollState(QR_CODE_STATUS.SUCCESS, legacyUrl()),
  })
  assert.equal(calls.length, 1)
})

test('cookies set by the poll answer need no ticket exchange', async () => {
  assert.deepEqual(await login(confirmed('', cookieHeaders(cookies))), credentials)
})

test('a ticket is exchanged at its own origin, keeping the cookies of a redirect it does not follow', async () => {
  const signal = new AbortController().signal
  const { fetch, calls } = fakeFetch(confirmed(ticketUrl), () => {
    const headers = cookieHeaders(cookies)
    headers.set('Location', 'https://www.bilibili.com/')
    return new Response(null, { status: 302, headers })
  })
  const result = await pollQRCode('fixture-key', { fetch, signal })
  assert.deepEqual(result.status === 'success' && result.credentials, credentials)
  assert.equal(calls.length, 2)
  assert.equal(calls[1]?.url, ticketUrl)
  assert.equal(calls[1]?.init.redirect, 'manual')
  assert.deepEqual(calls[1]?.init.headers, { ...DEFAULT_HEADERS, Referer: 'https://passport.bilibili.com/' })
  assert.ok(
    calls.every(call => call.init.signal === signal),
    "every request listens to the caller's signal"
  )
})

test('cookies are collected across approved passport redirects', async () => {
  const nextUrl = 'https://passport.bilibili.com/x/passport-login/web/crossDomain?ticket=fixture-next'
  const { SESSDATA, ...remaining } = cookies
  const signal = new AbortController().signal
  const { fetch, calls } = fakeFetch(
    confirmed(ticketUrl),
    () => {
      const headers = cookieHeaders({ SESSDATA: SESSDATA ?? '' })
      headers.set('Location', nextUrl)
      return new Response(null, { status: 302, headers })
    },
    url => {
      assert.equal(url, nextUrl)
      return new Response(null, { headers: cookieHeaders(remaining) })
    }
  )
  const result = await pollQRCode('fixture-key', { fetch, signal })
  assert.deepEqual(result.status === 'success' && result.credentials, credentials)
  assert.ok(
    calls.slice(1).every(call => call.init.redirect === 'manual'),
    'every hop is followed by hand'
  )
  assert.ok(
    calls.every(call => call.init.signal === signal),
    "every hop listens to the caller's signal"
  )
})

for (const loginUrl of [
  'http://passport.bilibili.com/login?ticket=fixture',
  'https://passport.bilibili.com.example.invalid/login?ticket=fixture',
  'https://fixture@passport.bilibili.com/login?ticket=fixture',
]) {
  test(`a ticket outside Bilibili's passport is never sent: ${loginUrl}`, async () => {
    const { fetch, calls } = fakeFetch(confirmed(loginUrl))
    await assert.rejects(pollQRCode('fixture-key', { fetch }), { reason: 'credentials' })
    assert.equal(calls.length, 1)
  })
}

test('a confirmed login with neither credentials nor a ticket rejects', async () => {
  const { fetch } = fakeFetch(confirmed(''))
  await assert.rejects(pollQRCode('fixture-key', { fetch }), { reason: 'credentials' })
})

test('a ticket redirect to another origin is not followed', async () => {
  const { fetch, calls } = fakeFetch(
    confirmed(ticketUrl),
    new Response(null, { status: 302, headers: { Location: 'https://example.invalid/login?ticket=fixture' } })
  )
  await assert.rejects(pollQRCode('fixture-key', { fetch }), { reason: 'credentials' })
  assert.equal(calls.length, 2)
})

/** Rejects as a credentials failure that, printed the way `console.error` prints it, shows nothing of `secret` */
async function rejectsWithout(secret: string, ...steps: Step[]): Promise<void> {
  await assert.rejects(pollQRCode('fixture-key', { fetch: fakeFetch(...steps).fetch }), error => {
    assert.ok(error instanceof QRLoginError)
    assert.equal(error.reason, 'credentials')
    assert.ok(!inspect(error).includes(secret), 'the error must not carry the login')
    return true
  })
}

test("a login URL that doesn't parse rejects without carrying it", () =>
  rejectsWithout('fixture-session', confirmed(legacyUrl().replace('.com/', '.com:99999/'))))

test("a ticket redirect that doesn't parse rejects without carrying the ticket", () =>
  rejectsWithout(
    'ticket=fixture',
    confirmed(ticketUrl),
    new Response(null, { status: 302, headers: { Location: 'http://[' } })
  ))

test("a ticket exchange answer's body is released even when its cookies don't decode", async () => {
  let cancelled = false
  const body = new ReadableStream({
    cancel() {
      cancelled = true
    },
  })
  const { fetch } = fakeFetch(confirmed(ticketUrl), new Response(body, { headers: { 'Set-Cookie': 'bili_jct=%ZZ' } }))
  await assert.rejects(pollQRCode('fixture-key', { fetch }), { reason: 'credentials' })
  assert.ok(cancelled, 'an unread body holds its connection')
})

test('a ticket redirect loop ends after five requests', async () => {
  const loop = Array.from({ length: 5 }, () => new Response(null, { status: 302, headers: { Location: ticketUrl } }))
  const { fetch, calls } = fakeFetch(confirmed(ticketUrl), ...loop)
  await assert.rejects(pollQRCode('fixture-key', { fetch }), { reason: 'credentials' })
  assert.equal(calls.length, 6)
})

for (const uid of ['0', '-1', '12oops', 'NaN', '9007199254740993']) {
  test(`UID ${uid} is not a login`, async () => {
    const { fetch } = fakeFetch(confirmed(legacyUrl({ DedeUserID: uid })), new Response('{}'))
    await assert.rejects(pollQRCode('fixture-key', { fetch }), { reason: 'credentials' })
  })
}

test("an abort rejects with the signal's reason, unwrapped", async () => {
  const controller = new AbortController()
  const reason = new DOMException('Fixture deadline', 'TimeoutError')
  const { fetch } = fakeFetch((_url, init) => {
    controller.abort(reason)
    throw init.signal?.reason
  })
  await assert.rejects(pollQRCode('fixture-key', { fetch, signal: controller.signal }), error => error === reason)
})

test('cookieStringFromCredentials encodes SESSDATA back for the Cookie header', () => {
  assert.equal(
    cookieStringFromCredentials(credentials),
    'SESSDATA=fixture-session%2Cpercent%25value; DedeUserID=12345; DedeUserID__ckMd5=fixture-checksum; bili_jct=fixture-csrf'
  )
  const { SESSDATA, DedeUserID, bili_jct } = credentials
  assert.equal(
    cookieStringFromCredentials({ SESSDATA, DedeUserID, bili_jct }),
    'SESSDATA=fixture-session%2Cpercent%25value; DedeUserID=12345; bili_jct=fixture-csrf'
  )
})

test('getCorrespondPath encrypts refresh_timestamp into a 1024-bit RSA-OAEP hex path', async t => {
  const realImportKey = globalThis.crypto.subtle.importKey.bind(globalThis.crypto.subtle)
  const realEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
  let importedFormat: KeyFormat | undefined
  let importedKeyData: JsonWebKey | BufferSource | undefined
  let importedAlgorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams | HmacImportParams | undefined
  let encryptedPlaintext = ''

  t.mock.method(
    globalThis.crypto.subtle,
    'importKey',
    async (
      format: KeyFormat,
      keyData: JsonWebKey | BufferSource,
      algorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams | HmacImportParams,
      extractable: boolean,
      keyUsages: readonly KeyUsage[]
    ) => {
      importedFormat = format
      importedKeyData = keyData
      importedAlgorithm = algorithm
      return realImportKey(format as 'jwk', keyData as JsonWebKey, algorithm, extractable, keyUsages)
    }
  )
  t.mock.method(
    globalThis.crypto.subtle,
    'encrypt',
    async (algorithm: AlgorithmIdentifier | RsaOaepParams, key: CryptoKey, data: BufferSource) => {
      encryptedPlaintext = new TextDecoder().decode(data)
      return realEncrypt(algorithm, key, data)
    }
  )

  const path = await getCorrespondPath(1_700_000_000_000)
  assert.match(path, /^[0-9a-f]{256}$/)
  assert.equal(importedFormat, 'jwk')
  assert.deepEqual(importedKeyData, {
    kty: 'RSA',
    n: 'y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE',
    e: 'AQAB',
  })
  assert.deepEqual(importedAlgorithm, { name: 'RSA-OAEP', hash: 'SHA-256' })
  assert.equal(encryptedPlaintext, 'refresh_1700000000000')
  await assert.rejects(getCorrespondPath(Number.NaN), RangeError)
})

test('checkCookieRefresh sends csrf and Cookie and returns whether a refresh is due', async () => {
  const infoResponse = {
    code: 0,
    message: '0',
    ttl: 1,
    data: { refresh: true, timestamp: 1_700_000_000_000 },
  }
  const signal = new AbortController().signal
  const { fetch, calls } = fakeFetch(Response.json(infoResponse))
  assert.deepEqual(await checkCookieRefresh(credentials, { fetch, signal }), {
    refresh: true,
    timestamp: 1_700_000_000_000,
    response: infoResponse,
  })
  const url = new URL(calls[0]?.url ?? '')
  assert.equal(`${url.origin}${url.pathname}`, COOKIE_REFRESH_ENDPOINTS.INFO)
  assert.equal(url.searchParams.get('csrf'), credentials.bili_jct)
  assert.deepEqual(calls[0]?.init.headers, {
    ...DEFAULT_HEADERS,
    Cookie: cookieStringFromCredentials(credentials),
  })
  assert.equal(calls[0]?.init.signal, signal)
})

for (const body of ['{"code":0}', '{"code":0,"data":{"refresh":true}}', '{"code":0,"data":{"timestamp":1}}']) {
  test(`checkCookieRefresh rejects an answer without refresh info: ${body}`, async () => {
    const { fetch } = fakeFetch(new Response(body))
    await assert.rejects(checkCookieRefresh(credentials, { fetch }), { reason: 'response' })
  })
}

test('refreshCookies exchanges refresh_csrf and refresh_token for new cookies and confirms them', async () => {
  const nextCredentials: BilibiliCredentials = {
    SESSDATA: 'next-session,percent%value',
    DedeUserID: 12345,
    DedeUserID__ckMd5: 'next-checksum',
    bili_jct: 'next-csrf',
  }
  const nextCookies: Record<string, string> = {
    ...nextCredentials,
    DedeUserID: String(nextCredentials.DedeUserID),
  }
  const refreshBody = {
    code: 0,
    message: '0',
    ttl: 1,
    data: { status: 0, message: '', refresh_token: 'next-refresh-token' },
  }
  const signal = new AbortController().signal
  const { fetch, calls } = fakeFetch(
    new Response('<html><body><div id="1-name">fixture-refresh-csrf</div></body></html>'),
    Response.json(refreshBody, { headers: cookieHeaders(nextCookies) }),
    Response.json({ code: 0, message: '0', ttl: 1 })
  )

  let callsCountWhenRotated = -1
  const result = await refreshCookies(credentials, 'old-refresh-token', {
    fetch,
    signal,
    timestamp: 1_700_000_000_000,
    onCredentialsRotated: rotated => {
      callsCountWhenRotated = calls.length
      assert.deepEqual(rotated, {
        credentials: nextCredentials,
        refreshToken: 'next-refresh-token',
        response: refreshBody,
      })
    },
  })
  assert.deepEqual(result, {
    credentials: nextCredentials,
    refreshToken: 'next-refresh-token',
    response: refreshBody,
  })
  assert.equal(callsCountWhenRotated, 2, 'onCredentialsRotated runs before confirm/refresh')
  assert.equal(calls.length, 3)

  const correspondPrefix = `${COOKIE_REFRESH_ENDPOINTS.CORRESPOND}/`
  assert.ok((calls[0]?.url ?? '').startsWith(correspondPrefix))
  assert.match((calls[0]?.url ?? '').slice(correspondPrefix.length), /^[0-9a-f]{256}$/)
  assert.equal(new Headers(calls[0]?.init.headers).get('Cookie'), cookieStringFromCredentials(credentials))

  assert.equal(calls[1]?.url, COOKIE_REFRESH_ENDPOINTS.REFRESH)
  assert.equal(calls[1]?.init.method, 'POST')
  assert.equal(new Headers(calls[1]?.init.headers).get('Cookie'), cookieStringFromCredentials(credentials))
  assert.equal(new Headers(calls[1]?.init.headers).get('Content-Type'), 'application/x-www-form-urlencoded')
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[1]?.init.body))), {
    csrf: credentials.bili_jct,
    refresh_csrf: 'fixture-refresh-csrf',
    source: 'main_web',
    refresh_token: 'old-refresh-token',
  })

  assert.equal(calls[2]?.url, COOKIE_REFRESH_ENDPOINTS.CONFIRM)
  assert.equal(calls[2]?.init.method, 'POST')
  assert.equal(new Headers(calls[2]?.init.headers).get('Cookie'), cookieStringFromCredentials(nextCredentials))
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[2]?.init.body))), {
    csrf: nextCredentials.bili_jct,
    refresh_token: 'old-refresh-token',
  })
  assert.ok(
    calls.every(call => call.init.signal === signal),
    "every step listens to the caller's signal"
  )
})

test('refreshCookies rejects an empty refreshToken before making any request', async () => {
  const { fetch, calls } = fakeFetch()
  await assert.rejects(refreshCookies(credentials, '', { fetch }), { reason: 'credentials' })
  assert.equal(calls.length, 0)
})

test("refreshCookies releases the correspond page's body on an HTTP error", async () => {
  let cancelled = false
  const body = new ReadableStream({
    cancel() {
      cancelled = true
    },
  })
  const { fetch } = fakeFetch(new Response(body, { status: 404 }))
  await assert.rejects(refreshCookies(credentials, 'old-refresh-token', { fetch }), {
    reason: 'http',
    status: 404,
  })
  assert.ok(cancelled)
})

for (const html of ['<html></html>', '<div id="1-name">   </div>']) {
  test(`refreshCookies rejects a correspond page without refresh_csrf: ${html}`, async () => {
    const { fetch } = fakeFetch(new Response(html))
    await assert.rejects(refreshCookies(credentials, 'old-refresh-token', { fetch }), { reason: 'response' })
  })
}

test('refreshCookies rejects a refresh answer without a new refresh_token', async () => {
  const { fetch, calls } = fakeFetch(
    new Response('<div id="1-name">fixture-refresh-csrf</div>'),
    Response.json({ code: 0, message: '0', ttl: 1, data: { status: 0, message: '', refresh_token: '' } })
  )
  await assert.rejects(refreshCookies(credentials, 'old-refresh-token', { fetch }), { reason: 'response' })
  assert.equal(calls.length, 2)
})

test('refreshCookies rejects a refresh answer without complete Set-Cookie credentials before confirming', async () => {
  const { fetch, calls } = fakeFetch(
    new Response('<div id="1-name">fixture-refresh-csrf</div>'),
    Response.json({ code: 0, message: '0', ttl: 1, data: { status: 0, message: '', refresh_token: 'next-token' } })
  )
  await assert.rejects(refreshCookies(credentials, 'old-refresh-token', { fetch }), { reason: 'credentials' })
  assert.equal(calls.length, 2)
})

test('refreshCookies keeps rotated credentials when confirm fails', async () => {
  const nextCredentials: BilibiliCredentials = {
    SESSDATA: 'next-session',
    DedeUserID: 12345,
    DedeUserID__ckMd5: 'next-checksum',
    bili_jct: 'next-csrf',
  }
  const refreshBody = {
    code: 0,
    message: '0',
    ttl: 1,
    data: { status: 0, message: '', refresh_token: 'next-refresh-token' },
  }
  const { fetch, calls } = fakeFetch(
    new Response('<div id="1-name">fixture-refresh-csrf</div>'),
    Response.json(refreshBody, {
      headers: cookieHeaders({ ...nextCredentials, DedeUserID: String(nextCredentials.DedeUserID) }),
    }),
    new Response('Bad gateway', { status: 502 })
  )

  const result = await refreshCookies(credentials, 'old-refresh-token', { fetch, timestamp: 1_700_000_000_000 })
  assert.deepEqual(result, {
    credentials: nextCredentials,
    refreshToken: 'next-refresh-token',
    response: refreshBody,
  })
  assert.equal(calls.length, 3)
})
