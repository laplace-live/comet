import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  type BilibiliCredentials,
  cookieStringFromCredentials,
  DEFAULT_HEADERS,
  generateQRCode,
  pollQRCode,
  QR_CODE_STATUS,
  QR_LOGIN_ENDPOINTS,
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
  assert.deepEqual(
    await login(
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
    ),
    credentials
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
