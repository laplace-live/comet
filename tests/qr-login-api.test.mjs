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
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString('utf8'),
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
let qrStatus

before(async () => {
  const bundle = await build({
    configFile: false,
    envFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'error',
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    build: {
      write: false,
      minify: false,
      target: 'esnext',
      lib: { entry: '\0qr-login-test:entry', formats: ['es'] },
      rollupOptions: { input: '\0qr-login-test:entry', external: /^node:/, output: { inlineDynamicImports: true } },
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
          export { BILIBILI_ENDPOINTS as endpoints } from '@/lib/const'
          export { QR_CODE_STATUS as qrStatus } from '@/types/bilibili'
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
  ;({ api, handlers, channels, endpoints, qrStatus } = await import(
    `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
  ))
  api.registerBilibiliIpcHandlers()
})

beforeEach(() => {
  api.clearAllAccounts()
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
      assert.equal(new Headers(init.headers).get('Cookie'), api.cookieStringFromCredentials(credentials))
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

for (const payload of [{ code: -400, message: 'Fixture API error' }, { code: 0 }, { code: 0, data: {} }, null]) {
  test(`outer API failure or malformed payload returns an actionable error: ${JSON.stringify(payload)}`, async t => {
    mockFetch(t, [Response.json(payload)])
    const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
    assert.equal(typeof result.error, 'string')
    await assertNoAccount()
  })
}

test('scanned status remains pending without account creation', async t => {
  const payload = { code: 0, data: { code: qrStatus.WAITING_CONFIRM, message: 'Scanned, waiting for confirmation' } }
  mockFetch(t, [Response.json(payload)])
  assert.deepEqual(await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' }), payload)
  await assertNoAccount()
})
