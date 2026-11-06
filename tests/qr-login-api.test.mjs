/* global globalThis */
import assert from 'node:assert/strict'
import { before, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

// Exercise the real main-process handlers without touching a user's account store
// or OS keychain. Vite bundles the TypeScript source and its existing @ imports
// entirely in memory, so these tests do not need an Electron process or a server.
const mockModules = {
  electron: `
    export const handlers = new Map()
    export const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
    export const safeStorage = {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async value => Buffer.from(value),
      decryptStringAsync: async value => ({ result: value.toString('utf8'), shouldReEncrypt: false }),
    }
  `,
  'electron-store': `
    export default class Store {
      constructor({ defaults }) { this.values = structuredClone(defaults) }
      get(key) { return this.values[key] }
      set(key, value) { this.values[key] = value }
    }
  `,
}

let handlers
let api
let channels
let endpoints
let qrEndpoints
let refreshEndpoints
let qrStatus
let cookieStringFromCredentials
let commonHeaders
let defaultHeaders

before(async () => {
  const bundle = await build({
    configFile: false,
    envDir: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'error',
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    build: {
      write: false,
      minify: false,
      target: 'esnext',
      lib: { entry: '\0qr-login-test:entry', formats: ['es'] },
      rolldownOptions: { input: '\0qr-login-test:entry', external: /^node:/, output: { codeSplitting: false } },
    },
    plugins: [
      {
        name: 'qr-login-test-electron',
        enforce: 'pre',
        resolveId(id) {
          if (id.startsWith('\0qr-login-test:')) return id
          if (id in mockModules) return { id: `\0qr-login-test:${id}`, external: false }
        },
        load(id) {
          if (id === '\0qr-login-test:entry')
            return `
          export * as api from '@/api/bilibili'
          export { handlers } from 'electron'
          export { IpcChannel as channels } from '@/lib/ipc'
          export { BILIBILI_ENDPOINTS as endpoints, COMMON_HEADERS as commonHeaders } from '@/lib/const'
          export {
            COOKIE_REFRESH_ENDPOINTS as refreshEndpoints,
            cookieStringFromCredentials,
            DEFAULT_HEADERS as defaultHeaders,
            QR_CODE_STATUS as qrStatus,
            QR_LOGIN_ENDPOINTS as qrEndpoints,
          } from '@laplace.live/bilibili-qr'
        `
          if (id.startsWith('\0qr-login-test:')) return mockModules[id.slice('\0qr-login-test:'.length)]
        },
      },
    ],
  })
  const chunk = [bundle]
    .flat()
    .flatMap(result => result.output)
    .find(item => item.type === 'chunk' && item.isEntry)
  assert.ok(chunk, 'Vite must build the test entry')
  ;({
    api,
    handlers,
    channels,
    endpoints,
    qrEndpoints,
    refreshEndpoints,
    qrStatus,
    cookieStringFromCredentials,
    commonHeaders,
    defaultHeaders,
  } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`))
  api.registerBilibiliIpcHandlers()
})

beforeEach(async () => {
  await api.clearAllAccounts()
})

const credentials = {
  SESSDATA: 'fixture-session,percent%value',
  DedeUserID: 12345,
  DedeUserID__ckMd5: 'fixture-checksum',
  bili_jct: 'fixture-csrf',
}
const userInfo = { mid: 12345, uname: 'Fixture user', face: 'https://example.invalid/avatar.png' }
const ticketUrl = 'https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=fixture'

function legacyUrl(overrides = {}) {
  return `https://passport.bilibili.com/login?${new URLSearchParams({ ...credentials, ...overrides })}`
}

function cookieHeaders(values = credentials) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(values)) {
    headers.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; Domain=.bilibili.com; HttpOnly`)
  }
  return headers
}

function pollResponse(url = legacyUrl(), headers) {
  return Response.json({ code: 0, message: '0', data: { code: 0, url, refresh_token: 'fixture-refresh' } }, { headers })
}

function navResponse() {
  return Response.json({ code: 0, data: { isLogin: true, ...userInfo } })
}

function invoke(channel, params) {
  assert.ok(handlers.has(channel), `Missing IPC handler: ${channel}`)
  return handlers.get(channel)({}, params)
}

function mockFetch(t, steps) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const step = steps[calls.length - 1]
    assert.ok(step, `Unexpected fetch: ${url}`)
    assert.ok(init.signal instanceof AbortSignal, 'Every login fetch needs a timeout signal')
    assert.equal(init.signal, calls[0].init.signal, 'All login requests must share one deadline')
    if (typeof step === 'function') return step(url, init)
    return step
  })
  t.mock.method(console, 'error', () => undefined)
  t.mock.method(console, 'warn', () => undefined)
  t.after(() => assert.equal(calls.length, steps.length, 'Not all expected fetches ran'))
  return calls
}

function mockDeadline(t) {
  const controller = new AbortController()
  let timeout
  const deadline = t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.ok(milliseconds > 0 && milliseconds <= 15_000, 'Login must have a bounded deadline')
    timeout = setTimeout(() => controller.abort(new DOMException('Fixture deadline', 'TimeoutError')), 10)
    return controller.signal
  })
  t.after(() => clearTimeout(timeout))
  return deadline
}

function stalledResponse(_url, { signal }) {
  signal.throwIfAborted()
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

async function assertStored(expectedCredentials = credentials, expectedUser = userInfo) {
  assert.deepEqual(await invoke(channels.BILIBILI_GET_CREDENTIALS), expectedCredentials)
  assert.deepEqual(await invoke(channels.BILIBILI_GET_ACCOUNTS), {
    accounts: [{ ...expectedUser, face: expectedUser.face, isExpired: false }],
    activeAccountMid: expectedUser.mid,
  })
}

async function assertNoAccount() {
  assert.equal(await invoke(channels.BILIBILI_GET_CREDENTIALS), null)
  assert.deepEqual(await invoke(channels.BILIBILI_GET_ACCOUNTS), { accounts: [], activeAccountMid: null })
}

test('legacy URL credentials complete login and persist the active account', async t => {
  const calls = mockFetch(t, [
    pollResponse(),
    (url, init) => {
      assert.equal(url, endpoints.NAV)
      assert.equal(new Headers(init.headers).get('Cookie'), cookieStringFromCredentials(credentials))
      return navResponse()
    },
  ])
  const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
  assert.equal(new URL(calls[0].url).searchParams.get('qrcode_key'), 'fixture-key')
  assert.equal(result.data.code, 0)
  assert.deepEqual(result.credentials, credentials)
  assert.deepEqual(result.userInfo, userInfo)
  await assertStored()
})

test('ticket login captures Set-Cookie from a manual redirect before fetching NAV', async t => {
  const calls = mockFetch(t, [
    pollResponse(ticketUrl),
    (url, init) => {
      assert.equal(url, ticketUrl)
      assert.equal(init.redirect, 'manual')
      const headers = cookieHeaders()
      headers.set('Location', 'https://www.bilibili.com/')
      return new Response(null, { status: 302, headers })
    },
    navResponse(),
  ])
  const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
  assert.deepEqual(result.credentials, credentials)
  assert.equal(calls.at(-1).url, endpoints.NAV)
  await assertStored()
})

test('cookie credentials delivered directly by QR poll do not require a ticket request', async t => {
  mockFetch(t, [pollResponse('', cookieHeaders()), navResponse()])
  const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
  assert.deepEqual(result.credentials, credentials)
  await assertStored()
})

test('partial cookies are collected across approved passport redirects', async t => {
  const nextUrl = 'https://passport.bilibili.com/x/passport-login/web/crossDomain?ticket=fixture-next'
  mockFetch(t, [
    pollResponse(ticketUrl),
    (url, init) => {
      assert.equal(url, ticketUrl)
      assert.equal(init.redirect, 'manual')
      const headers = cookieHeaders({ SESSDATA: credentials.SESSDATA })
      headers.set('Location', nextUrl)
      return new Response(null, { status: 302, headers })
    },
    (url, init) => {
      assert.equal(url, nextUrl)
      assert.equal(init.redirect, 'manual')
      const remaining = Object.fromEntries(Object.entries(credentials).filter(([name]) => name !== 'SESSDATA'))
      return new Response(null, { headers: cookieHeaders(remaining) })
    },
    navResponse(),
  ])
  const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
  assert.deepEqual(result.credentials, credentials)
  await assertStored()
})

test('confirmed login without valid credentials returns an error and stores nothing', async t => {
  mockFetch(t, [pollResponse(ticketUrl), new Response('{}')])
  const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
  assert.equal(typeof result.error, 'string')
  assert.equal(result.credentials, undefined)
  await assertNoAccount()
})

for (const invalidUrl of [
  '',
  'http://passport.bilibili.com/login?ticket=fixture',
  'https://passport.bilibili.com.example.invalid/login?ticket=fixture',
  'https://fixture@passport.bilibili.com/login?ticket=fixture',
]) {
  test(`missing or untrusted ticket URL cannot create an account: ${invalidUrl}`, async t => {
    mockFetch(t, [pollResponse(invalidUrl)])
    const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
    assert.equal(typeof result.error, 'string')
    await assertNoAccount()
  })
}

test('a ticket redirect to an unapproved origin is not followed', async t => {
  mockFetch(t, [
    pollResponse(ticketUrl),
    new Response(null, {
      status: 302,
      headers: { Location: 'https://example.invalid/login?ticket=fixture' },
    }),
  ])
  const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
  assert.equal(typeof result.error, 'string')
  await assertNoAccount()
})

test('a ticket redirect loop ends after a bounded number of requests', async t => {
  mockFetch(t, [
    pollResponse(ticketUrl),
    ...Array.from({ length: 5 }, () => new Response(null, { status: 302, headers: { Location: ticketUrl } })),
  ])
  const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
  assert.equal(typeof result.error, 'string')
  await assertNoAccount()
})

for (const invalidUid of ['0', '-1', '12oops', 'NaN', '9007199254740993']) {
  test(`invalid UID ${invalidUid} cannot create a successful account`, async t => {
    mockFetch(t, [pollResponse(legacyUrl({ DedeUserID: invalidUid })), new Response('{}')])
    const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
    assert.equal(typeof result.error, 'string')
    await assertNoAccount()
  })
}

test('skipSave returns credentials for reauthentication without persisting them', async t => {
  mockFetch(t, [pollResponse(ticketUrl), new Response(null, { headers: cookieHeaders() }), navResponse()])
  const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key', skipSave: true })
  assert.deepEqual(result.credentials, credentials)
  assert.deepEqual(result.userInfo, userInfo)
  await assertNoAccount()
})

test('NAV failure still completes login with the valid credential UID', async t => {
  mockFetch(t, [
    pollResponse(),
    () => {
      throw new Error('Fixture NAV failure')
    },
  ])
  const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
  const fallbackUser = { mid: credentials.DedeUserID, uname: `User ${credentials.DedeUserID}` }
  assert.deepEqual(result.credentials, credentials)
  assert.deepEqual(result.userInfo, fallbackUser)
  await assertStored(credentials, fallbackUser)
})

test('a stalled NAV request times out and completes login using the credential UID', async t => {
  const deadline = mockDeadline(t)
  mockFetch(t, [pollResponse(), stalledResponse])
  const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
  assert.equal(deadline.mock.callCount(), 1)
  assert.deepEqual(result.credentials, credentials)
  await assertStored(credentials, { mid: credentials.DedeUserID, uname: `User ${credentials.DedeUserID}` })
})

test('a stalled QR poll times out with an error and creates no account', async t => {
  const deadline = mockDeadline(t)
  mockFetch(t, [stalledResponse])
  const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
  assert.equal(deadline.mock.callCount(), 1)
  assert.equal(typeof result.error, 'string')
  await assertNoAccount()
})

const INVALID_POLL = { error: '登录状态响应无效，请刷新二维码重试', code: 502 }
for (const [payload, expected] of [
  // A refusal shows Bilibili's explanation, or the app's own without one
  [
    { code: -400, message: 'Fixture API error' },
    { error: 'Fixture API error', code: -400 },
  ],
  [
    { code: -400, message: '' },
    { error: '查询登录状态失败，请刷新二维码重试', code: -400 },
  ],
  [{ code: 0 }, INVALID_POLL],
  [{ code: 0, data: {} }, INVALID_POLL],
  [null, INVALID_POLL],
]) {
  test(`a refused or malformed poll answer returns an actionable error: ${JSON.stringify(payload)}`, async t => {
    mockFetch(t, [Response.json(payload)])
    assert.deepEqual(await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' }), expected)
    await assertNoAccount()
  })
}

test("the login package's DEFAULT_HEADERS stay the app's COMMON_HEADERS, so a Chrome bump reaches both", () => {
  assert.deepEqual(defaultHeaders, commonHeaders)
})

test('a refused QR code request without an explanation gets the generic error', async t => {
  mockFetch(t, [Response.json({ code: -400, message: '' })])
  assert.deepEqual(await invoke(channels.BILIBILI_QR_GENERATE), { error: 'Failed to generate QR code', code: -400 })
})

test('scanned status remains pending without account creation', async t => {
  const payload = { code: 0, data: { code: qrStatus.WAITING_CONFIRM, message: 'Scanned, waiting for confirmation' } }
  mockFetch(t, [Response.json(payload)])
  assert.deepEqual(await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' }), payload)
  await assertNoAccount()
})

test('two logins that finish together both keep their account', async t => {
  const other = { ...credentials, DedeUserID: 67890 }
  // Each poll signs in its own account; NAV answers for whichever account the cookie carries
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input))
    if (`${url.origin}${url.pathname}` === qrEndpoints.POLL) {
      return pollResponse(url.searchParams.get('qrcode_key') === 'other-key' ? legacyUrl(other) : legacyUrl())
    }
    const mid = Number(/DedeUserID=(\d+)/.exec(new Headers(init.headers).get('Cookie'))?.[1])
    return Response.json({ code: 0, data: { isLogin: true, mid, uname: `Fixture ${mid}` } })
  })
  const results = await Promise.all([
    invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' }),
    invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'other-key' }),
  ])
  assert.deepEqual(
    results.map(result => result.userInfo?.mid),
    [credentials.DedeUserID, other.DedeUserID]
  )
  const { accounts } = await invoke(channels.BILIBILI_GET_ACCOUNTS)
  assert.deepEqual(
    accounts.map(account => account.mid).sort(),
    [credentials.DedeUserID, other.DedeUserID].sort(),
    "neither login's save may drop the other's account"
  )
})

test('BILIBILI_CHECK_LOGIN renews cookies when Bilibili signals refresh and persists the rotated token', async t => {
  mockFetch(t, [pollResponse(), navResponse()])
  await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })

  const refreshedCredentials = {
    SESSDATA: 'refreshed-session',
    DedeUserID: 12345,
    DedeUserID__ckMd5: 'refreshed-checksum',
    bili_jct: 'refreshed-csrf',
  }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, init })
    if (url === endpoints.NAV) return navResponse()
    if (url.startsWith(refreshEndpoints.INFO)) {
      return Response.json({ code: 0, message: '0', ttl: 1, data: { refresh: true, timestamp: 1_700_000_000_000 } })
    }
    if (url.startsWith(`${refreshEndpoints.CORRESPOND}/`)) {
      return new Response('<html><div id="1-name">fixture-refresh-csrf</div></html>')
    }
    if (url === refreshEndpoints.REFRESH) {
      return Response.json(
        { code: 0, message: '0', ttl: 1, data: { status: 0, message: '', refresh_token: 'rotated-refresh' } },
        { headers: cookieHeaders(refreshedCredentials) }
      )
    }
    if (url === refreshEndpoints.CONFIRM) {
      return Response.json({ code: 0, message: '0', ttl: 1 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const checkResult = await invoke(channels.BILIBILI_CHECK_LOGIN)
  assert.deepEqual(checkResult, { isLogin: true, ...userInfo })
  assert.equal(calls.length, 5)
  await assertStored(refreshedCredentials, userInfo)
  const storedAccounts = await api.getAccounts()
  assert.equal(storedAccounts[0]?.refreshToken, 'rotated-refresh')
})

test('BILIBILI_CHECK_LOGIN does not mark accounts expired on transient network or HTTP failures', async t => {
  mockFetch(t, [pollResponse(), navResponse()])
  await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })

  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network offline')
  })
  assert.deepEqual(await invoke(channels.BILIBILI_CHECK_LOGIN), { isLogin: true, ...userInfo })
  await assertStored()

  t.mock.method(globalThis, 'fetch', async () => new Response('Bad gateway', { status: 502 }))
  assert.deepEqual(await invoke(channels.BILIBILI_CHECK_LOGIN), { isLogin: true, ...userInfo })
  await assertStored()
})

test('BILIBILI_CHECK_LOGIN marks an explicitly signed-out account expired and switches to the next valid account', async t => {
  const other = { ...credentials, DedeUserID: 67890, SESSDATA: 'other-session' }
  const otherUser = { mid: 67890, uname: 'Second user', face: 'https://example.invalid/second.png' }

  mockFetch(t, [pollResponse(), navResponse()])
  await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })

  mockFetch(t, [pollResponse(legacyUrl(other)), Response.json({ code: 0, data: { isLogin: true, ...otherUser } })])
  await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'other-key' })

  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input)
    const cookie = new Headers(init.headers).get('Cookie') || ''
    if (url === endpoints.NAV) {
      if (cookie.includes(`DedeUserID=${credentials.DedeUserID}`)) {
        return Response.json({ code: -101, message: '账号未登录', data: { isLogin: false } })
      }
      return Response.json({ code: 0, data: { isLogin: true, ...otherUser } })
    }
    if (url.startsWith(refreshEndpoints.INFO)) {
      return Response.json({ code: 0, message: '0', ttl: 1, data: { refresh: false, timestamp: 1_700_000_000_000 } })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const checkResult = await invoke(channels.BILIBILI_CHECK_LOGIN)
  assert.deepEqual(checkResult, { isLogin: true, ...otherUser })
  assert.deepEqual(await invoke(channels.BILIBILI_GET_ACCOUNTS), {
    accounts: [
      { ...userInfo, isExpired: true },
      { ...otherUser, isExpired: false },
    ],
    activeAccountMid: otherUser.mid,
  })
})

test('BILIBILI_REAUTH_ACCOUNT updates credentials and refreshToken', async t => {
  mockFetch(t, [pollResponse(), navResponse()])
  await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })

  const nextCredentials = { ...credentials, SESSDATA: 'reauth-session', bili_jct: 'reauth-csrf' }
  t.mock.method(globalThis, 'fetch', async () => navResponse())
  const reauth = await invoke(channels.BILIBILI_REAUTH_ACCOUNT, {
    mid: credentials.DedeUserID,
    credentials: nextCredentials,
    refreshToken: 'reauth-refresh-token',
  })
  assert.equal(reauth.success, true)
  await assertStored(nextCredentials, userInfo)
  const storedAccounts = await api.getAccounts()
  assert.equal(storedAccounts[0]?.refreshToken, 'reauth-refresh-token')

  const sameSessionReauth = await invoke(channels.BILIBILI_REAUTH_ACCOUNT, {
    mid: credentials.DedeUserID,
    credentials: nextCredentials,
  })
  assert.equal(sameSessionReauth.success, true)
  assert.equal((await api.getAccounts())[0]?.refreshToken, 'reauth-refresh-token')
})

test('BILIBILI_CHECK_LOGIN starts a fresh check when the active account changes while a check is in flight', async t => {
  const other = { ...credentials, DedeUserID: 67890, SESSDATA: 'other-session' }
  const otherUser = { mid: 67890, uname: 'Second user', face: 'https://example.invalid/second.png' }

  mockFetch(t, [pollResponse(), navResponse()])
  await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })

  mockFetch(t, [pollResponse(legacyUrl(other)), Response.json({ code: 0, data: { isLogin: true, ...otherUser } })])
  await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'other-key' })

  const firstNav = Promise.withResolvers()
  const firstNavStarted = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input)
    const cookie = new Headers(init.headers).get('Cookie') || ''
    if (url === endpoints.NAV) {
      if (cookie.includes(`DedeUserID=${credentials.DedeUserID}`)) {
        firstNavStarted.resolve()
        return firstNav.promise
      }
      return Response.json({ code: 0, data: { isLogin: true, ...otherUser } })
    }
    if (url.startsWith(refreshEndpoints.INFO)) {
      return Response.json({ code: 0, message: '0', ttl: 1, data: { refresh: false, timestamp: 1_700_000_000_000 } })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const staleCheck = invoke(channels.BILIBILI_CHECK_LOGIN)
  await firstNavStarted.promise

  await invoke(channels.BILIBILI_SET_ACTIVE_ACCOUNT, { mid: otherUser.mid })
  const switchedCheck = invoke(channels.BILIBILI_CHECK_LOGIN)
  firstNav.resolve(navResponse())

  assert.deepEqual(await switchedCheck, { isLogin: true, ...otherUser })
  assert.deepEqual(await staleCheck, { isLogin: true, ...otherUser })
  assert.equal(api.getActiveAccountMid(), otherUser.mid)
})
