/* global globalThis */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

// The customer service handlers' Wbi-signed requests against fixture replies: a rejected signature must not
// pass for an answer, and a message must never go out twice. Bundled in memory like qr-login-api.test.mjs,
// so no account store, keychain or network is touched.
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

const credentials = { SESSDATA: 'fixture-session', DedeUserID: 12345, bili_jct: 'fixture-csrf' }
const shop = { shopFatherId: 0, shopId: 0 }

// NAV answers both the login's profile lookup and the Wbi keys
const nav = () =>
  Response.json({
    code: 0,
    data: {
      isLogin: true,
      mid: credentials.DedeUserID,
      uname: 'Fixture user',
      wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
      },
    },
  })
// What Bilibili sends instead of an answer when it refuses a signature
const rejection = () => Response.json({ code: 0, message: '0', data: { v_voucher: 'voucher_fixture' } })
const blockPage = status => new Response('<html>blocked</html>', { status })

/**
 * Answer fetches by URL, so caches carried between tests (Wbi keys, buvids) don't change the script.
 * @param replies - for the customer service endpoint under test, in order
 */
function mockFetch(t, endpoint, replies) {
  const calls = { endpoint: 0, nav: 0 }
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input)
    if (url.startsWith(endpoints.NAV)) {
      calls.nav++
      return nav()
    }
    if (url.startsWith(endpoints.FINGER_SPI)) return Response.json({ code: 0, data: { b_3: 'b3', b_4: 'b4' } })
    if (url.startsWith(endpoint)) {
      const reply = replies[calls.endpoint++]
      assert.ok(reply, `Unexpected request number ${calls.endpoint} to ${endpoint}`)
      return reply()
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  t.mock.method(console, 'error', () => undefined)
  t.mock.method(console, 'warn', () => undefined)
  return calls
}

function invoke(channel, params) {
  assert.ok(handlers.has(channel), `Missing IPC handler: ${channel}`)
  return handlers.get(channel)({}, params)
}

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
      lib: { entry: '\0cs-api-test:entry', formats: ['es'] },
      rolldownOptions: { input: '\0cs-api-test:entry', external: /^node:/, output: { codeSplitting: false } },
    },
    plugins: [
      {
        name: 'cs-api-test-electron',
        enforce: 'pre',
        resolveId(id) {
          if (id.startsWith('\0cs-api-test:')) return id
          if (id in mockModules) return { id: `\0cs-api-test:${id}`, external: false }
        },
        load(id) {
          if (id === '\0cs-api-test:entry')
            return `
          export * as api from '@/api/bilibili'
          export { handlers } from 'electron'
          export { IpcChannel as channels } from '@/lib/ipc'
          export { BILIBILI_ENDPOINTS as endpoints } from '@/lib/const'
        `
          if (id.startsWith('\0cs-api-test:')) return mockModules[id.slice('\0cs-api-test:'.length)]
        },
      },
    ],
  })
  const chunk = [bundle]
    .flat()
    .flatMap(result => result.output)
    .find(item => item.type === 'chunk' && item.isEntry)
  assert.ok(chunk, 'Vite must build the test entry')
  ;({ api, handlers, channels, endpoints } = await import(
    `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
  ))
  api.registerBilibiliIpcHandlers()

  // Sign in the only way the store takes an account: a QR login whose poll carries the credentials
  const realFetch = globalThis.fetch
  globalThis.fetch = async input =>
    String(input).startsWith(endpoints.NAV)
      ? nav()
      : Response.json({
          code: 0,
          data: { code: 0, url: `https://passport.bilibili.com/login?${new URLSearchParams(credentials)}` },
        })
  try {
    const login = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: 'fixture-key' })
    assert.equal(login.userInfo?.mid, credentials.DedeUserID, 'the fixture account should sign in')
  } finally {
    globalThis.fetch = realFetch
  }
})

const send = (senderMid = credentials.DedeUserID) =>
  invoke(channels.BILIBILI_CUSTOMER_SERVICE_SEND_MESSAGE, {
    ...shop,
    msgType: 1,
    content: '{"content":"你好"}',
    senderMid,
  })

test('a send from an account that is no longer signed in is refused', async t => {
  const calls = mockFetch(t, endpoints.CUSTOMER_SERVICE_SEND_MESSAGE, [])
  const result = await send(67890)
  assert.equal(calls.endpoint, 0, 'it must not go out from the account signed in now')
  assert.ok(result.error, 'it should say the message was not sent')
})

test('a send answered with an error page is not sent again', async t => {
  const calls = mockFetch(t, endpoints.CUSTOMER_SERVICE_SEND_MESSAGE, [() => blockPage(502)])
  const result = await send()
  assert.equal(calls.endpoint, 1, 'it may have gone through, so it must not be resent')
  assert.ok(result.error, 'it should not report a send it cannot confirm')
})

test('a send blocked by risk control is signed again with fresh keys and resent once', async t => {
  const calls = mockFetch(t, endpoints.CUSTOMER_SERVICE_SEND_MESSAGE, [
    () => blockPage(412),
    // Written out, since a number this size would already lose its last digits here
    () => new Response('{"code":0,"message":"0","data":{"msg_key":9000000000000000001}}'),
  ])
  const navBefore = calls.nav
  const result = await send()
  assert.equal(calls.endpoint, 2, 'a 412 was never processed, so one resend is safe')
  assert.ok(calls.nav > navBefore, 'the resend should be signed with refreshed keys')
  assert.equal(result.data?.msg_key, '9000000000000000001', 'the msg_key should keep every digit')
})

test('a rejected signature is not taken for a sent message', async t => {
  const calls = mockFetch(t, endpoints.CUSTOMER_SERVICE_SEND_MESSAGE, [rejection, rejection])
  const result = await send()
  assert.equal(calls.endpoint, 2, 'a rejection should be retried once with fresh keys')
  assert.ok(result.error, `a rejection must not pass for a sent message, got ${JSON.stringify(result)}`)
})

test('a rejected fetch is signed again and gets the page', async t => {
  const page = { messages: [], has_more: 0, min_seqno: '0', max_seqno: '0' }
  const calls = mockFetch(t, endpoints.CUSTOMER_SERVICE_FETCH_MESSAGES, [
    rejection,
    () => Response.json({ code: 0, message: '0', data: page }),
  ])
  const result = await invoke(channels.BILIBILI_CUSTOMER_SERVICE_FETCH_MESSAGES, shop)
  assert.equal(calls.endpoint, 2, 'the rejected fetch should be retried')
  assert.deepEqual(result.data, page, 'the retry should return the page')
})
