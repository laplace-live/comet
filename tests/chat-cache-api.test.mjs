/* global globalThis */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

// The disk cache behind Settings › 在本机保留聊天记录, through the real main-process handlers: what's saved comes back
// as saved, sealed, and goes with its account. Bundled in memory like qr-login-api.test.mjs, with userData in a
// temporary folder and safeStorage faked by a byte flip behind a key number, so a sealed file reads as nothing
// and a key that changed shows.
const userData = await mkdtemp(path.join(tmpdir(), 'comet-chat-cache-'))
const cacheDir = path.join(userData, 'Chat Cache')

const mockModules = {
  electron: `
    export const handlers = new Map()
    export const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
    export const app = { getPath: name => (name === 'userData' ? ${JSON.stringify(userData)} : undefined) }
    // hold: { skip, reached, promise } holds the decryption after the next skip of them, until promise settles
    export const keychain = { available: true, key: 1, hold: null }
    const flip = bytes => Buffer.from(bytes.map(byte => byte ^ 0x5a))
    export const safeStorage = {
      getSelectedStorageBackend: () => 'gnome_libsecret',
      isAsyncEncryptionAvailable: async () => keychain.available,
      encryptStringAsync: async value => Buffer.concat([Buffer.from([keychain.key]), flip(Buffer.from(value))]),
      decryptStringAsync: async value => {
        const hold = keychain.hold
        if (hold && hold.skip-- === 0) {
          keychain.hold = null
          hold.reached()
          await hold.promise
        }
        return { result: flip(value.subarray(1)).toString('utf8'), shouldReEncrypt: value[0] !== keychain.key }
      },
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

let api
let handlers
let channels
let endpoints
let keychain

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
      lib: { entry: '\0chat-cache-test:entry', formats: ['es'] },
      rolldownOptions: { input: '\0chat-cache-test:entry', external: /^node:/, output: { codeSplitting: false } },
    },
    plugins: [
      {
        name: 'chat-cache-test-electron',
        enforce: 'pre',
        resolveId(id) {
          if (id.startsWith('\0chat-cache-test:')) return id
          if (id in mockModules) return { id: `\0chat-cache-test:${id}`, external: false }
        },
        load(id) {
          if (id === '\0chat-cache-test:entry')
            return `
          export * as api from '@/api/bilibili'
          export { handlers, keychain } from 'electron'
          export { IpcChannel as channels } from '@/lib/ipc'
          export { BILIBILI_ENDPOINTS as endpoints } from '@/lib/const'
        `
          if (id.startsWith('\0chat-cache-test:')) return mockModules[id.slice('\0chat-cache-test:'.length)]
        },
      },
    ],
  })
  const chunk = [bundle]
    .flat()
    .flatMap(result => result.output)
    .find(item => item.type === 'chunk' && item.isEntry)
  assert.ok(chunk, 'Vite must build the test entry')
  ;({ api, handlers, channels, endpoints, keychain } = await import(
    `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
  ))
  api.registerBilibiliIpcHandlers()
})

beforeEach(async () => {
  keychain.available = true
  keychain.key = 1
  keychain.hold = null
  await api.clearAllAccounts()
})

after(() => rm(userData, { recursive: true, force: true }))

function invoke(channel, params) {
  assert.ok(handlers.has(channel), `Missing IPC handler: ${channel}`)
  return handlers.get(channel)({}, params)
}

const FIRST = 111
const SECOND = 222
const FRIEND = 9001

/** Sign an account in through a QR login, as the app does */
async function signIn(t, mid) {
  const credentials = { SESSDATA: `session-${mid}`, DedeUserID: mid, DedeUserID__ckMd5: 'checksum', bili_jct: 'csrf' }
  const url = `https://passport.bilibili.com/login?${new URLSearchParams(credentials)}`
  t.mock.method(globalThis, 'fetch', async input =>
    String(input) === endpoints.NAV
      ? Response.json({ code: 0, data: { isLogin: true, mid, uname: `user ${mid}`, face: '' } })
      : Response.json({ code: 0, message: '0', data: { code: 0, url, refresh_token: 'refresh' } })
  )
  const result = await invoke(channels.BILIBILI_QR_POLL, { qrcodeKey: `key-${mid}` })
  assert.equal(result.userInfo?.mid, mid, 'the account should sign in')
  t.mock.restoreAll()
}

const lists = () => ({
  sessions: [{ talker_id: FRIEND, session_ts: 5, last_msg: { content: '{"content":"秘密的话"}' } }],
  hasMoreSessions: false,
  nextEndTs: null,
  unfollowFold: false,
  unfollowed: [],
  unfollowedUnread: 0,
  hasMoreUnfollowed: false,
  unfollowedNextEndTs: null,
  userCache: { [FRIEND]: { name: '朋友', face: '' } },
})

const chat = (size, text = '悄悄话') => ({
  messages: Array.from({ length: size }, (_, i) => ({
    msg_seqno: i + 1,
    sender_uid: FRIEND,
    content: JSON.stringify({ content: `${text} ${i + 1}` }),
    msg_key: '7300000000000000001',
  })),
  emojiInfoMap: {},
  syncedSeqno: size,
  users: { [FRIEND]: { name: '朋友', face: '' } },
})

const filesOf = mid => readdir(path.join(cacheDir, String(mid))).catch(() => [])
const flip = bytes => Buffer.from(bytes.map(byte => byte ^ 0x5a))

test('lists and chats come back as saved, sealed, in files whose names say nothing of the chats', async t => {
  await signIn(t, FIRST)
  await invoke(channels.BILIBILI_CACHE_SAVE_LISTS, { mid: FIRST, lists: lists() })
  await invoke(channels.BILIBILI_CACHE_SAVE_CHAT, { mid: FIRST, key: `1:${FRIEND}`, chat: chat(3) })

  assert.deepEqual(await invoke(channels.BILIBILI_CACHE_LOAD_LISTS, { mid: FIRST }), lists())
  assert.deepEqual(await invoke(channels.BILIBILI_CACHE_LOAD_CHAT, { mid: FIRST, key: `1:${FRIEND}` }), chat(3))
  assert.equal(await invoke(channels.BILIBILI_CACHE_LOAD_CHAT, { mid: FIRST, key: '1:1' }), null)
  assert.equal(await invoke(channels.BILIBILI_CACHE_LOAD_LISTS, { mid: SECOND }), null)

  const files = await filesOf(FIRST)
  assert.equal(files.length, 3, `the lists, the index and the chat, got ${files}`)
  for (const file of files) {
    assert.ok(!file.includes(String(FRIEND)), `a file's name should say nothing of the chat: ${file}`)
    const sealed = await readFile(path.join(cacheDir, String(FIRST), file))
    for (const plain of ['秘密的话', '悄悄话', '朋友', String(FRIEND), '7300000000000000001']) {
      assert.ok(!sealed.includes(plain), `${file} should hold no ${plain} in the clear`)
    }
  }
})

test("nothing is saved for an account that isn't stored, nor while safeStorage can't encrypt", async t => {
  await signIn(t, FIRST)
  await invoke(channels.BILIBILI_CACHE_SAVE_LISTS, { mid: SECOND, lists: lists() })
  await invoke(channels.BILIBILI_CACHE_SAVE_CHAT, { mid: SECOND, key: `1:${FRIEND}`, chat: chat(1) })
  assert.deepEqual(await readdir(cacheDir).catch(() => []), [], "an account that isn't stored should get nothing")

  keychain.available = false
  await invoke(channels.BILIBILI_CACHE_SAVE_LISTS, { mid: FIRST, lists: lists() })
  await invoke(channels.BILIBILI_CACHE_SAVE_CHAT, { mid: FIRST, key: `1:${FRIEND}`, chat: chat(1) })
  assert.deepEqual(await filesOf(FIRST), [], 'nothing should be written in the clear')
  keychain.available = true
  assert.equal(await invoke(channels.BILIBILI_CACHE_LOAD_LISTS, { mid: FIRST }), null)
})

test('signing out or removing an account deletes what was saved of it, and clearing deletes it all', async t => {
  await signIn(t, FIRST)
  await signIn(t, SECOND)
  for (const mid of [FIRST, SECOND]) {
    await invoke(channels.BILIBILI_CACHE_SAVE_LISTS, { mid, lists: lists() })
    await invoke(channels.BILIBILI_CACHE_SAVE_CHAT, { mid, key: `1:${FRIEND}`, chat: chat(2) })
  }

  await invoke(channels.BILIBILI_REMOVE_ACCOUNT, { mid: SECOND })
  assert.deepEqual(await filesOf(SECOND), [], 'removing an account should delete what was saved of it')
  assert.equal((await filesOf(FIRST)).length, 3, "the other account's should stay")
  await invoke(channels.BILIBILI_CACHE_SAVE_LISTS, { mid: SECOND, lists: lists() })
  assert.deepEqual(await filesOf(SECOND), [], 'a save for it after should be refused')

  await invoke(channels.BILIBILI_LOGOUT)
  assert.deepEqual(await filesOf(FIRST), [], 'signing out should delete what was saved of the account')

  await signIn(t, FIRST)
  await invoke(channels.BILIBILI_CACHE_SAVE_LISTS, { mid: FIRST, lists: lists() })
  await invoke(channels.BILIBILI_CACHE_CLEAR)
  assert.deepEqual(await readdir(cacheDir).catch(() => []), [], 'clearing should delete everything')
})

test('past the budget, the chats used least recently go', async t => {
  await signIn(t, FIRST)
  const save = (key, size) => invoke(channels.BILIBILI_CACHE_SAVE_CHAT, { mid: FIRST, key, chat: chat(size) })
  await save('1:1', 30_000)
  await save('1:2', 15_000)
  // Opened since, the first is the one used most recently
  assert.ok(await invoke(channels.BILIBILI_CACHE_LOAD_CHAT, { mid: FIRST, key: '1:1' }))
  await save('1:3', 10_000)

  const load = key => invoke(channels.BILIBILI_CACHE_LOAD_CHAT, { mid: FIRST, key })
  assert.equal(await load('1:2'), null, 'the chat used least recently should go')
  assert.equal((await load('1:1'))?.messages.length, 30_000)
  assert.equal((await load('1:3'))?.messages.length, 10_000)
  assert.equal((await filesOf(FIRST)).length, 3, "the index and the two chats left: the one gone shouldn't stay")

  await save('1:4', 60_000)
  assert.equal((await load('1:4'))?.messages.length, 60_000, 'one past the budget on its own should still be saved')
  assert.equal(await load('1:1'), null, 'the rest should make way for it')
})

test('a file it cannot read, or saved by another version, reads as nothing and goes', async t => {
  await signIn(t, FIRST)
  const file = path.join(cacheDir, String(FIRST), 'lists')
  await invoke(channels.BILIBILI_CACHE_SAVE_LISTS, { mid: FIRST, lists: lists() })
  await writeFile(file, 'not sealed')
  assert.equal(await invoke(channels.BILIBILI_CACHE_LOAD_LISTS, { mid: FIRST }), null)
  assert.ok(!(await filesOf(FIRST)).includes('lists'), 'an unreadable file should be deleted')

  await writeFile(
    file,
    Buffer.concat([Buffer.from([1]), flip(Buffer.from(JSON.stringify({ version: 0, value: lists() })))])
  )
  assert.equal(await invoke(channels.BILIBILI_CACHE_LOAD_LISTS, { mid: FIRST }), null)
  assert.ok(!(await filesOf(FIRST)).includes('lists'), "another version's file should be deleted")
})

test('a file sealed with a key safeStorage has since replaced is sealed again as it is read', async t => {
  await signIn(t, FIRST)
  await invoke(channels.BILIBILI_CACHE_SAVE_LISTS, { mid: FIRST, lists: lists() })
  keychain.key = 2
  assert.deepEqual(await invoke(channels.BILIBILI_CACHE_LOAD_LISTS, { mid: FIRST }), lists())
  const sealed = await readFile(path.join(cacheDir, String(FIRST), 'lists'))
  assert.equal(sealed[0], 2, 'it should be sealed with the current key')
})

test('saved chats can be searched by any of their messages, each giving every one that holds the text', async t => {
  await signIn(t, FIRST)
  await signIn(t, SECOND)
  const message = (seqno, text, overrides = {}) => ({
    msg_seqno: seqno,
    msg_type: 1,
    msg_status: 0,
    sender_uid: FRIEND,
    timestamp: seqno,
    content: JSON.stringify({ content: text }),
    msg_key: `${seqno}000`,
    ...overrides,
  })
  const users = {
    [FIRST]: { name: '我', face: '' },
    [FRIEND]: { name: '朋友', face: '' },
    [SECOND]: { name: '另一个号', face: '' },
  }
  const saved = messages => ({ messages, emojiInfoMap: {}, syncedSeqno: messages.length, users })
  const save = (mid, key, messages) => invoke(channels.BILIBILI_CACHE_SAVE_CHAT, { mid, key, chat: saved(messages) })
  await save(FIRST, `1:${FRIEND}`, [
    message(1, '早前说的 Asdaf123'),
    message(2, '我回的 asdaf123', { sender_uid: FIRST }),
    message(3, '最后'),
  ])
  await save(FIRST, '1:2', [message(1, '撤回了的 asdaf123', { msg_status: 1 }), message(2, '无关')])
  await save(SECOND, '1:3', [message(1, 'asdaf123')])

  const search = (mid, query) => invoke(channels.BILIBILI_CACHE_SEARCH_CHATS, { mid, query })
  assert.deepEqual(await search(FIRST, 'ASDAF123'), [
    {
      key: `1:${FRIEND}`,
      matches: [
        { msgKey: '2000', text: '我回的 asdaf123', senderUid: FIRST, timestamp: 2 },
        { msgKey: '1000', text: '早前说的 Asdaf123', senderUid: FRIEND, timestamp: 1 },
      ],
      // Only the names of those who sent what was found
      users: { [FIRST]: users[FIRST], [FRIEND]: users[FRIEND] },
    },
  ])
  assert.deepEqual(await search(FIRST, '没说过的话'), [])
  assert.deepEqual(await search(SECOND, 'asdaf123'), [
    {
      key: '1:3',
      matches: [{ msgKey: '1000', text: 'asdaf123', senderUid: FRIEND, timestamp: 1 }],
      users: { [FRIEND]: users[FRIEND] },
    },
  ])

  keychain.available = false
  assert.deepEqual(await search(FIRST, 'asdaf123'), [], "nothing should be read while safeStorage can't decrypt")
})

test('opening the chat used most recently leaves the index as it is, and opening another moves it last', async t => {
  await signIn(t, FIRST)
  const save = key => invoke(channels.BILIBILI_CACHE_SAVE_CHAT, { mid: FIRST, key, chat: chat(2) })
  const load = key => invoke(channels.BILIBILI_CACHE_LOAD_CHAT, { mid: FIRST, key })
  const index = () => stat(path.join(cacheDir, String(FIRST), 'chats')).then(({ ino }) => ino)
  await save('1:1')
  await save('1:2')

  const before = await index()
  assert.ok(await load('1:2'))
  assert.equal(await index(), before, 'opening the chat already last should not write the index again')
  assert.ok(await load('1:1'))
  assert.notEqual(await index(), before, 'opening another should move it last')
})

test('a search overtaken by a newer one stops partway, answering nothing, and the newer one answers', async t => {
  await signIn(t, FIRST)
  for (const talker of [1, 2, 3]) {
    await invoke(channels.BILIBILI_CACHE_SAVE_CHAT, { mid: FIRST, key: `1:${talker}`, chat: chat(2) })
  }
  const search = query => invoke(channels.BILIBILI_CACHE_SEARCH_CHATS, { mid: FIRST, query })

  // The typing goes on while the first search reads its first chat, past its index
  const reading = Promise.withResolvers()
  const release = Promise.withResolvers()
  keychain.hold = { skip: 1, reached: reading.resolve, promise: release.promise }
  const overtaken = search('悄悄')
  await reading.promise
  const latest = search('悄悄话 2')
  release.resolve()

  assert.deepEqual(await overtaken, [], 'the search overtaken should stop, though chats it has yet to read match')
  const found = (await latest).map(match => match.key).sort()
  assert.deepEqual(found, ['1:1', '1:2', '1:3'], 'the newer search should look through every chat')
})
