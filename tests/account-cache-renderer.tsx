import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { VirtuosoMockContext } from 'react-virtuoso'

import type {
  BilibiliLinkSettingResponse,
  BilibiliMessage,
  BilibiliMessagesResponse,
  BilibiliSession,
  BilibiliSessionsResponse,
  BilibiliSingleUnreadResponse,
  BilibiliUserCardsResponse,
} from '@/types/bilibili'
import type {
  CachedChatParams,
  CachedListsParams,
  CheckLoginResult,
  ErrorResponse,
  FetchMessagesParams,
  FetchSessionsParams,
  FetchUsersParams,
  NewMessageNotification,
  SaveCachedChatParams,
  SaveCachedListsParams,
  SearchCachedChatsParams,
} from '@/types/electron'

import {
  ChatCache,
  findMessage,
  keepLoadedPages,
  listsToSave,
  type MessageMatch,
  mergeMessages,
  SAVED_SESSIONS,
  type SavedChat,
} from '@/lib/account-cache'

import { type ChatOpening, type UsePrivateMessagesReturn, usePrivateMessages } from '@/hooks/usePrivateMessages'

import { MessagesPanel } from '@/components/comet/MessagesPanel'
import { SessionItem } from '@/components/comet/SessionItem'
import { SEARCH_PAGE_GAP, SessionList, searchMatch } from '@/components/comet/SessionList'

import { useSettings } from '@/stores/useSettings'

const globals = window as unknown as {
  IS_REACT_ACT_ENVIRONMENT: boolean
  __rendererTestResults: { tests: Array<{ name: string; ok: boolean; error?: string }> }
}
globals.IS_REACT_ACT_ENVIRONMENT = true

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const ME = 123
const OTHER = 789
// My chats, newest first
const FRIEND = 201
const FAN = 202
const COLLEAGUE = 203
// The other account's
const OTHER_FRIEND = 301
// Someone who writes to me while I'm away
const NEWCOMER = 401

const NAMES: Record<number, string> = { [ME]: 'me', [OTHER]: 'other' }

function session(talkerId: number, ts: number, overrides: Partial<BilibiliSession> = {}): BilibiliSession {
  return {
    talker_id: talkerId,
    session_type: 1,
    at_seqno: 0,
    top_ts: 0,
    group_name: '',
    group_cover: '',
    is_follow: 1,
    is_dnd: 0,
    ack_seqno: 0,
    ack_ts: 0,
    session_ts: ts * 1_000_000,
    unread_count: 0,
    last_msg: null,
    group_type: 0,
    can_fold: 0,
    status: 0,
    max_seqno: ts,
    new_push_msg: 0,
    setting: 0,
    is_guardian: 0,
    is_intercept: 0,
    is_trust: 0,
    system_msg_type: 0,
    live_status: 0,
    biz_msg_unread_count: 0,
    user_label: null,
    ...overrides,
  }
}

function message(senderUid: number, seqno: number, overrides: Partial<BilibiliMessage> = {}): BilibiliMessage {
  return {
    sender_uid: senderUid,
    receiver_type: 1,
    receiver_id: ME,
    msg_type: 1,
    content: JSON.stringify({ content: `消息 ${seqno}` }),
    msg_seqno: seqno,
    timestamp: seqno,
    at_uids: null,
    msg_key: `${seqno}000`,
    msg_status: 0,
    notify_code: '',
    msg_source: 0,
    ...overrides,
  }
}

interface Account {
  /** Newest first, as Bilibili lists them */
  chats: BilibiliSession[]
  /** Each chat's messages, oldest first */
  messages: Record<number, BilibiliMessage[]>
}

let current: UsePrivateMessagesReturn
let root!: Root
let server: Record<number, Account>
let signedInMid: number
let storedMids: number[]
// The main process's cache on disk, which a relaunch keeps: `${mid}/lists` and `${mid}/chat/${key}`
let disk: Map<string, unknown>
// The account the next login check moves on to, as when the signed-in one signed out on Bilibili's side
let failOverTo: number | null
let pageSize: number
// Lists asked for in the background (with a mid) fail
let failBackgroundLists: boolean
// Holds back the next list of this account's, until resolved: as Bilibili has it then, or as it had it when asked
let listGate: { mid: number; promise: Promise<unknown>; answered: boolean } | null
// Holds back the next messages asked for, until resolved
let messagesGate: Promise<unknown> | null
// Messages asked for fail
let failMessages: boolean
// Holds back the next message sent, until resolved
let sendGate: Promise<unknown> | null
let sessionRequests: FetchSessionsParams[]
let messageRequests: FetchMessagesParams[]
let userRequests: FetchUsersParams[]
let onNewMessage: (notification: NewMessageNotification) => void

const reply = { code: 0, msg: '0', message: '0', ttl: 1 }

function sessionsReply(list: BilibiliSession[], hasMore: boolean): BilibiliSessionsResponse {
  return {
    ...reply,
    data: {
      session_list: list,
      has_more: hasMore ? 1 : 0,
      anti_disturb_cleaning: false,
      is_address_list_empty: 0,
      show_level: false,
    },
  }
}

// Bilibili's own order: pinned first, then newest first
function listed(list: BilibiliSession[]): BilibiliSession[] {
  return [...list].sort((a, b) => b.top_ts - a.top_ts || b.session_ts - a.session_ts)
}

function Harness() {
  current = usePrivateMessages()
  return null
}

async function flush(callback: () => unknown = () => undefined) {
  await act(async () => {
    await callback()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function installApi() {
  window.electronAPI = {
    setBadgeCount: async () => ({ success: true }),
    bilibili: {
      getAccounts: async () => ({
        accounts: storedMids.map(mid => ({ mid, uname: NAMES[mid], isExpired: false })),
        activeAccountMid: signedInMid,
      }),
      checkLogin: async (): Promise<CheckLoginResult> => {
        if (failOverTo !== null) {
          signedInMid = failOverTo
          failOverTo = null
        }
        return { isLogin: true, mid: signedInMid, uname: NAMES[signedInMid] }
      },
      setActiveAccount: async ({ mid }: { mid: number }) => {
        signedInMid = mid
        return { success: true }
      },
      removeAccount: async ({ mid }: { mid: number }) => {
        storedMids = storedMids.filter(m => m !== mid)
        forgetOnDisk(mid)
        return {
          success: true,
          remainingAccounts: storedMids.map(m => ({ mid: m, uname: NAMES[m], isExpired: false })),
          activeAccountMid: signedInMid,
        }
      },
      wsConnect: async () => ({ success: true }),
      wsDisconnect: async () => ({ success: true }),
      fetchLinkSetting: async (): Promise<BilibiliLinkSettingResponse> => ({
        ...reply,
        data: { show_unfollowed_msg: 0 },
      }),
      fetchSingleUnread: async (): Promise<BilibiliSingleUnreadResponse> => ({
        ...reply,
        data: {
          unfollow_unread: 0,
          follow_unread: 0,
          unfollow_push_msg: 0,
          dustbin_push_msg: 0,
          dustbin_unread: 0,
          biz_msg_unfollow_unread: 0,
          biz_msg_follow_unread: 0,
          custom_unread: 0,
        },
      }),
      // Answered for the account asked as, else the one signed in when asked, as the main process does
      fetchSessions: async (params: FetchSessionsParams) => {
        sessionRequests.push(params)
        const mid = params.mid ?? signedInMid
        if (params.mid !== undefined && failBackgroundLists) {
          return { error: 'Failed to fetch sessions from Bilibili', code: 500 }
        }
        const answer = () => {
          const all = listed(server[mid].chats)
          const endTs = params.endTs === undefined ? Infinity : Number(params.endTs)
          const rest = params.endTs === undefined ? all : all.filter(s => !s.top_ts && s.session_ts < endTs)
          // Copies, as off the network: what the hook holds doesn't change with Bilibili's side
          return sessionsReply(
            rest.slice(0, pageSize).map(s => ({ ...s })),
            rest.length > pageSize
          )
        }
        const gate = listGate?.mid === mid ? listGate : null
        if (!gate) return answer()
        listGate = null
        const early = gate.answered ? answer() : null
        await gate.promise
        return early ?? answer()
      },
      // Newest first within (begin, end), pages of `size`, as fetch_session_msgs answers
      fetchMessages: async (params: FetchMessagesParams): Promise<BilibiliMessagesResponse | ErrorResponse> => {
        messageRequests.push(params)
        const gate = messagesGate
        messagesGate = null
        await gate
        if (failMessages) return { error: 'Failed to fetch messages', code: 500 }
        const begin = params.beginSeqno ? Number(params.beginSeqno) : 0
        const end = params.endSeqno ? Number(params.endSeqno) : Infinity
        const inRange = (server[params.mid ?? signedInMid].messages[Number(params.talkerId)] ?? [])
          .filter(m => m.msg_seqno > begin && m.msg_seqno < end)
          .reverse()
        const page = inRange.slice(0, Number(params.size ?? 20)).map(m => ({ ...m }))
        return {
          ...reply,
          data: {
            messages: page,
            has_more: inRange.length > page.length ? 1 : 0,
            min_seqno: page.length > 0 ? page[page.length - 1].msg_seqno : 0,
            max_seqno: page.length > 0 ? page[0].msg_seqno : 0,
          },
        }
      },
      updateAck: async () => ({ code: 0 }),
      sendMessage: async () => {
        const gate = sendGate
        sendGate = null
        await gate
        return { ...reply, data: { msg_key: 9_000_000, msg_content: '' } }
      },
      fetchUsers: async (params: FetchUsersParams): Promise<BilibiliUserCardsResponse> => {
        userRequests.push(params)
        return {
          ...reply,
          data: params.uids.split(',').map(uid => ({
            mid: Number(uid),
            name: `用户名 ${uid}`,
            face: '',
            sign: '',
            rank: 0,
            level: 0,
            silence: 0,
            vip: { type: 0, status: 0, due_date: 0, nickname_color: '' },
            official: { role: 0, title: '', desc: '', type: -1 },
          })),
        }
      },
      logout: async () => {
        storedMids = storedMids.filter(m => m !== signedInMid)
        forgetOnDisk(signedInMid)
        signedInMid = storedMids[0]
        return { success: true }
      },
      // Copies, as through IPC; saves only for stored accounts, as the main process does
      cache: {
        loadLists: async ({ mid }: CachedListsParams) => structuredClone(disk.get(`${mid}/lists`) ?? null),
        saveLists: async ({ mid, lists }: SaveCachedListsParams) => {
          if (storedMids.includes(mid)) disk.set(`${mid}/lists`, structuredClone(lists))
        },
        loadChat: async ({ mid, key }: CachedChatParams) => structuredClone(disk.get(`${mid}/chat/${key}`) ?? null),
        saveChat: async ({ mid, key, chat }: SaveCachedChatParams) => {
          if (storedMids.includes(mid)) disk.set(`${mid}/chat/${key}`, structuredClone(chat))
        },
        // Through the account's saved chats, each giving the newest message that holds the text, as the main process does
        searchChats: async ({ mid, query }: SearchCachedChatsParams) =>
          [...disk].flatMap(([id, chat]) => {
            if (!id.startsWith(`${mid}/chat/`)) return []
            const match = findMessage((chat as SavedChat).messages, query.toLowerCase())
            return match === null ? [] : [{ key: id.slice(`${mid}/chat/`.length), ...match }]
          }),
        clear: async () => disk.clear(),
      },
      showNotification: async () => ({ shown: true }),
      onNewMessage: (callback: (notification: NewMessageNotification) => void) => {
        onNewMessage = callback
        return () => undefined
      },
      onSessionUpdate: () => () => undefined,
      onWsConnected: () => () => undefined,
      onWsDisconnected: () => () => undefined,
      onNavigateToSession: () => () => undefined,
    },
  } as unknown as typeof window.electronAPI
}

function forgetOnDisk(mid: number) {
  for (const key of disk.keys()) if (key.startsWith(`${mid}/`)) disk.delete(key)
}

async function setup({ failBackground = false } = {}) {
  server = {
    [ME]: {
      chats: [session(FRIEND, 50), session(FAN, 40), session(COLLEAGUE, 30)],
      messages: { [FAN]: [message(FAN, 1), message(ME, 2), message(FAN, 3)] },
    },
    [OTHER]: { chats: [session(OTHER_FRIEND, 70)], messages: {} },
  }
  signedInMid = ME
  storedMids = [ME, OTHER]
  disk = new Map()
  failOverTo = null
  useSettings.setState({ keepChatsOnDevice: true })
  pageSize = 100
  failBackgroundLists = failBackground
  listGate = null
  messagesGate = null
  failMessages = false
  sendGate = null
  sessionRequests = []
  messageRequests = []
  userRequests = []
  installApi()
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
  await flush(() => root.render(<Harness />))
  await flush(() => window.dispatchEvent(new Event('focus')))
  assert(current.userInfo?.mid === ME, 'the harness should log in')
  await flush(() => current.fetchSessions())
}

/** Quit and launch again: what was in memory goes, and what's on disk stays */
async function relaunch() {
  await flush(() => root.unmount())
  sessionRequests = []
  messageRequests = []
  userRequests = []
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
  await flush(() => root.render(<Harness />))
}

const ids = (list: BilibiliSession[]) => list.map(s => s.talker_id).join(',')
const shown = () => ids(current.sessions)
const contents = () => current.messages.map(m => m.msg_seqno).join(',')

function holdList(mid: number, { answered = false } = {}) {
  const gate = deferred<void>()
  listGate = { mid, promise: gate.promise, answered }
  return gate
}

function holdMessages() {
  const gate = deferred<void>()
  messagesGate = gate.promise
  return gate
}

function chatOf(talkerId: number): BilibiliSession {
  const found = current.sessions.find(s => s.talker_id === talkerId)
  if (!found) throw new Error(`${talkerId} should be listed`)
  return found
}

const tests: Array<{ name: string; run: () => Promise<void> }> = []
function test(name: string, run: () => Promise<void>) {
  tests.push({ name, run })
}

test("the other accounts' lists load in the background, as those accounts", async () => {
  await setup()
  const background = sessionRequests.filter(p => p.mid !== undefined)
  assert(
    background.length === 1 && background[0].mid === OTHER,
    `the other account's list should load once, as it, got ${JSON.stringify(background)}`
  )
  assert(
    userRequests.some(p => p.mid === OTHER && p.uids === String(OTHER_FRIEND)),
    "the other account's contacts should be looked up as it"
  )
})

test('switching to an account loaded in the background shows it at once, then refreshes it', async () => {
  await setup()
  server[OTHER].chats.push(session(NEWCOMER, 80))
  const gate = holdList(OTHER)
  let switching!: Promise<void>
  await flush(() => {
    switching = current.switchAccount(OTHER)
  })

  assert(shown() === `${OTHER_FRIEND}`, `its lists should show at once, got ${shown()}`)
  assert(!current.loading, 'no skeleton should cover lists already known')
  assert(current.userInfo?.mid === OTHER && current.userInfo.uname === 'other', 'who it is should show at once')
  assert(current.userCache[OTHER_FRIEND]?.name === `用户名 ${OTHER_FRIEND}`, 'names should show at once')

  await flush(async () => {
    gate.resolve()
    await switching
  })
  assert(shown() === `${NEWCOMER},${OTHER_FRIEND}`, `the lists should refresh behind it, got ${shown()}`)
})

test('switching back shows the account as it was left, then refreshes it', async () => {
  await setup()
  await flush(() => current.switchAccount(OTHER))
  assert(shown() === `${OTHER_FRIEND}`, `the switch should land, got ${shown()}`)

  server[ME].chats.push(session(NEWCOMER, 90))
  const gate = holdList(ME)
  let switching!: Promise<void>
  await flush(() => {
    switching = current.switchAccount(ME)
  })
  assert(shown() === `${FRIEND},${FAN},${COLLEAGUE}`, `it should show as it was left, got ${shown()}`)
  assert(!current.loading, 'no skeleton should cover it')
  assert(current.userCache[FRIEND]?.name === `用户名 ${FRIEND}`, 'its names should still be known')

  await flush(async () => {
    gate.resolve()
    await switching
  })
  assert(shown() === `${NEWCOMER},${FRIEND},${FAN},${COLLEAGUE}`, `it should refresh behind it, got ${shown()}`)
})

test('an account with nothing kept shows a skeleton until its lists land, not an empty list', async () => {
  await setup({ failBackground: true })
  failBackgroundLists = false
  const gate = holdList(OTHER)
  let switching!: Promise<void>
  await flush(() => {
    switching = current.switchAccount(OTHER)
  })
  assert(
    current.loading && current.sessions.length === 0,
    `a skeleton should show while its lists load, got loading ${current.loading} and ${shown()}`
  )
  assert(current.userInfo?.uname === 'other', 'who it is should show at once')

  await flush(async () => {
    gate.resolve()
    await switching
  })
  assert(!current.loading && shown() === `${OTHER_FRIEND}`, `its lists should land, got ${shown()}`)
})

test('opening a chat again shows it at once and asks only for what came since', async () => {
  await setup()
  await flush(() => current.selectSession(chatOf(FAN)))
  assert(contents() === '1,2,3', `the chat should load, got ${contents()}`)
  await flush(() => current.selectSession(chatOf(FRIEND)))

  server[ME].messages[FAN].push(message(FAN, 4))
  const gate = holdMessages()
  const asked = messageRequests.length
  await flush(() => current.selectSession(chatOf(FAN)))
  assert(contents() === '1,2,3' && !current.messagesLoading, `it should show at once, got ${contents()}`)
  assert(
    messageRequests.length === asked + 1 && messageRequests[asked].beginSeqno === '3',
    `only what came after the newest held should be asked for, got ${JSON.stringify(messageRequests.slice(asked))}`
  )

  await flush(() => gate.resolve())
  assert(contents() === '1,2,3,4', `what came since should be added, got ${contents()}`)
})

test('a chat that got more than a page since pages back until it meets what it held', async () => {
  await setup()
  await flush(() => current.selectSession(chatOf(FAN)))
  await flush(() => current.clearSelectedSession())
  for (let seqno = 4; seqno <= 2500; seqno++) server[ME].messages[FAN].push(message(FAN, seqno))

  await flush(() => current.selectSession(chatOf(FAN)))
  assert(current.messages.length === 2500, `every message should be there, got ${current.messages.length}`)
  assert(
    current.messages.every((m, i) => m.msg_seqno === i + 1),
    'the messages should run in order with nothing missing'
  )
})

test('a chat stays kept when switching away and back, under its own account', async () => {
  await setup()
  await flush(() => current.selectSession(chatOf(FAN)))
  await flush(() => current.switchAccount(OTHER))
  assert(current.selectedSession === null && current.messages.length === 0, "the chat shouldn't stay open")
  await flush(() => current.switchAccount(ME))

  const gate = holdMessages()
  await flush(() => current.selectSession(chatOf(FAN)))
  assert(contents() === '1,2,3' && !current.messagesLoading, `it should show at once, got ${contents()}`)
  await flush(() => gate.resolve())
})

test('a recall that comes over the WebSocket takes back the message it names', async () => {
  await setup()
  await flush(() => current.selectSession(chatOf(FAN)))
  await flush(() =>
    onNewMessage({
      talkerId: FAN,
      sessionType: 1,
      instantMsg: {
        senderUid: FAN,
        receiverType: 1,
        receiverId: ME,
        msgType: 5,
        content: '3000',
        msgSeqno: 5,
        timestamp: 5,
        msgKey: '5000',
      },
    })
  )
  const recalled = current.messages.find(m => m.msg_seqno === 3)
  assert(recalled?.msg_status === 1, `the message it names should show as recalled, got ${recalled?.msg_status}`)
})

const said = (text: string) => ({ content: JSON.stringify({ content: text }) })

test("a chat's new messages fetched for one account don't land in its contact's chat under another", async () => {
  await setup()
  // Both accounts talk to FAN
  server[OTHER].chats.push(session(FAN, 60))
  server[OTHER].messages[FAN] = [message(FAN, 1, said('给另一个号的'))]
  await flush(() => current.selectSession(chatOf(FAN)))

  // A message comes for it, fetched quietly, and answered only once the other account shows its FAN chat
  server[ME].messages[FAN].push(message(FAN, 4, said('给这个号的')))
  const gate = holdMessages()
  await flush(() => onNewMessage({ talkerId: FAN, sessionType: 1 }))
  await flush(() => current.switchAccount(OTHER))
  await flush(() => current.selectSession(chatOf(FAN)))
  assert(contents() === '1', `the other account's chat should show, got ${contents()}`)
  await flush(() => gate.resolve())
  assert(contents() === '1', `this account's message should not land in the other's chat, got ${contents()}`)
})

test("a message sent from one account's chat doesn't land in its contact's chat under another", async () => {
  await setup()
  server[OTHER].chats.push(session(FAN, 60))
  server[OTHER].messages[FAN] = [message(FAN, 1, said('给另一个号的'))]
  await flush(() => current.selectSession(chatOf(FAN)))

  // Sent, and answered only once the other account shows its FAN chat
  const gate = deferred<void>()
  sendGate = gate.promise
  let sending!: Promise<boolean>
  await flush(() => {
    sending = current.sendMessage('从这个号发的')
  })
  await flush(() => current.switchAccount(OTHER))
  await flush(() => current.selectSession(chatOf(FAN)))
  await flush(async () => {
    gate.resolve()
    assert(await sending, 'the message should send')
  })
  assert(contents() === '1', `the message should not land in the other account's chat, got ${contents()}`)
})

test("a chat whose history failed to load isn't kept, so opening it again loads all of it", async () => {
  await setup()
  server[ME].messages[FAN] = Array.from({ length: 1500 }, (_, i) => message(i % 2 ? ME : FAN, i + 1))
  const gate = holdMessages()
  await flush(() => current.selectSession(chatOf(FAN)))

  // A message comes over the WebSocket while its history loads, then the load fails
  await flush(() =>
    onNewMessage({
      talkerId: FAN,
      sessionType: 1,
      instantMsg: {
        senderUid: FAN,
        receiverType: 1,
        receiverId: ME,
        msgType: 1,
        content: JSON.stringify({ content: '新消息' }),
        msgSeqno: 1501,
        timestamp: 1501,
        msgKey: '1501000',
      },
    })
  )
  failMessages = true
  await flush(() => gate.resolve())
  failMessages = false
  assert(current.messages.length === 1, `only the message that came should show, got ${current.messages.length}`)

  await flush(() => current.selectSession(chatOf(FRIEND)))
  await flush(() => current.selectSession(chatOf(FAN)))
  assert(current.messages.length === 1500, `its whole history should load, got ${current.messages.length}`)
})

test("a recall answered after another chat opened leaves that chat's messages as they are", async () => {
  await setup()
  server[ME].messages[FRIEND] = [message(FRIEND, 1), message(ME, 2), message(FRIEND, 3)]
  await flush(() => current.selectSession(chatOf(FAN)))
  const gate = deferred<void>()
  sendGate = gate.promise
  let recalling!: Promise<{ success: boolean }>
  await flush(() => {
    recalling = current.recallMessage(2, '2000')
  })

  // The same seqno is another message there, which the recall isn't for
  await flush(() => current.selectSession(chatOf(FRIEND)))
  await flush(async () => {
    gate.resolve()
    assert((await recalling).success, 'the recall should go through')
  })
  const same = current.messages.find(m => m.msg_seqno === 2)
  assert(same?.msg_status === 0, `the other chat's message should not show as recalled, got ${same?.msg_status}`)
})

test('a search finds chats by any message held of them, opened here or saved on disk, as their account', async () => {
  await setup()
  server[ME].messages[FAN] = [message(FAN, 1, said('早前的 Asdaf 消息')), message(ME, 2), message(FAN, 3)]
  await flush(() => current.selectSession(chatOf(FAN)))
  const saved = (talkerId: number, text: string): SavedChat => ({
    messages: [message(talkerId, 5, said(text)), message(talkerId, 6)],
    emojiInfoMap: {},
    syncedSeqno: 6,
    users: {},
  })
  disk.set(`${ME}/chat/1:${COLLEAGUE}`, saved(COLLEAGUE, 'asdaf 也在这'))
  disk.set(`${OTHER}/chat/1:${OTHER_FRIEND}`, saved(OTHER_FRIEND, '另一个号的 asdaf'))

  const found = await current.searchHeldChats('  ASDAF ')
  const opened = found.get(`1:${FAN}`)
  assert(
    opened?.text === '早前的 Asdaf 消息' && opened.msgKey === '1000',
    `the chat opened here should be found, by that message, got ${JSON.stringify(opened)}`
  )
  const onDisk = found.get(`1:${COLLEAGUE}`)
  assert(
    onDisk?.text === 'asdaf 也在这' && onDisk.msgKey === '5000',
    `the chat saved on disk should be found, by that message, got ${JSON.stringify(onDisk)}`
  )
  assert(found.size === 2, `only the shown account's chats should be searched, got ${[...found.keys()]}`)
  assert((await current.searchHeldChats('没说过的话')).size === 0, 'text no message holds should find nothing')
})

test('each opening of a chat is new, at the message a search found it by or at its newest', async () => {
  await setup()
  await flush(() => current.selectSession(chatOf(FAN), '1000'))
  const first = current.chatOpening
  assert(first?.msgKey === '1000', `the chat should open at the message, got ${JSON.stringify(first)}`)
  await flush(() => current.selectSession(chatOf(FAN), '1000'))
  const again = current.chatOpening
  assert(
    again?.msgKey === '1000' && again.id !== first?.id,
    `opening it there again should go back there, got ${JSON.stringify(again)}`
  )
  await flush(() => current.selectSession(chatOf(FAN)))
  const plain = current.chatOpening
  assert(
    plain?.msgKey === null && plain.id !== again?.id,
    `opened otherwise, it should open anew at its newest, got ${JSON.stringify(plain)}`
  )
  await flush(() => current.selectSession(chatOf(FRIEND), '1000'))
  await flush(() => current.clearSelectedSession())
  assert(current.chatOpening === null, 'a chat closed should leave nothing to open at')
})

test('a message recalled since finds its chat no more, though the copy on disk still holds it', async () => {
  await setup()
  server[ME].messages[FAN] = [message(FAN, 1), message(ME, 2), message(FAN, 3, said('asdaf'))]
  await flush(() => current.selectSession(chatOf(FAN)))
  disk.set(`${ME}/chat/1:${FAN}`, { messages: server[ME].messages[FAN], emojiInfoMap: {}, syncedSeqno: 3, users: {} })
  await flush(() =>
    onNewMessage({
      talkerId: FAN,
      sessionType: 1,
      instantMsg: {
        senderUid: FAN,
        receiverType: 1,
        receiverId: ME,
        msgType: 5,
        content: '3000',
        msgSeqno: 4,
        timestamp: 4,
        msgKey: '4000',
      },
    })
  )
  const found = await current.searchHeldChats('asdaf')
  assert(!found.has(`1:${FAN}`), `what a recalled message said should no longer find its chat, got ${[...found]}`)
})

test('a message keeps the pages loaded past the first, instead of going back to the first page', async () => {
  await setup()
  pageSize = 100
  server[ME].chats = Array.from({ length: 150 }, (_, i) => session(1000 + i, i + 1))
  await flush(() => current.fetchSessions())
  await flush(() => current.loadMoreSessions())
  assert(current.sessions.length === 150, `both pages should load, got ${current.sessions.length}`)

  // A message moves an old chat to the top
  const moved = server[ME].chats[9]
  moved.session_ts = 500 * 1_000_000
  await flush(() => onNewMessage({ talkerId: moved.talker_id, sessionType: 1 }))

  assert(current.sessions.length === 150, `the second page should stay, got ${current.sessions.length}`)
  assert(current.sessions[0].talker_id === moved.talker_id, 'the chat should move to the top')
  assert(new Set(current.sessions.map(s => s.talker_id)).size === 150, 'no chat should show twice')
})

test('when more changed than the first page holds, the list goes back to the first page', async () => {
  await setup()
  server[ME].chats = Array.from({ length: 150 }, (_, i) => session(1000 + i, i + 1))
  await flush(() => current.fetchSessions())
  await flush(() => current.loadMoreSessions())

  // More chats than a page got messages: what follows the first page isn't known anymore
  for (const [i, chat] of server[ME].chats.slice(0, 120).entries()) chat.session_ts = (1000 + i) * 1_000_000
  await flush(() => onNewMessage({ talkerId: server[ME].chats[0].talker_id, sessionType: 1 }))
  assert(current.sessions.length === 100, `only the first page should stay, got ${current.sessions.length}`)
  assert(current.hasMoreSessions, 'the rest should load as before')
})

test('a next page asked before a refresh started the list over is dropped, and the rest still loads', async () => {
  await setup()
  server[ME].chats = Array.from({ length: 150 }, (_, i) => session(1000 + i, i + 1))
  await flush(() => current.fetchSessions())
  const gate = holdList(ME)
  let loadingMore!: Promise<void>
  await flush(() => {
    loadingMore = current.loadMoreSessions()
  })

  // While it's out, more chats than a page got messages, and a refresh starts the list over from its first page
  for (const [i, chat] of server[ME].chats.slice(0, 120).entries()) chat.session_ts = (1000 + i) * 1_000_000
  await flush(() => onNewMessage({ talkerId: server[ME].chats[0].talker_id, sessionType: 1 }))
  assert(current.sessions.length === 100, `the list should start over, got ${current.sessions.length}`)

  await flush(async () => {
    gate.resolve()
    await loadingMore
  })
  assert(current.hasMoreSessions, 'the page asked from where the old list ended should not end this one')
  await flush(() => current.loadMoreSessions())
  assert(current.sessions.length === 150, `the rest should load, got ${current.sessions.length}`)
  assert(new Set(current.sessions.map(s => s.talker_id)).size === 150, 'no chat should show twice')
})

test('a next page Bilibili answered before a chat on it moved to the top shows that chat once, at the top', async () => {
  await setup()
  server[ME].chats = Array.from({ length: 250 }, (_, i) => session(1000 + i, i + 1))
  await flush(() => current.fetchSessions())
  await flush(() => current.loadMoreSessions())
  assert(current.sessions.length === 200, `two pages should be loaded, got ${current.sessions.length}`)
  const gate = holdList(ME, { answered: true })
  let loadingMore!: Promise<void>
  await flush(() => {
    loadingMore = current.loadMoreSessions()
  })

  // Once the third page is answered, a chat on it gets a message: the refresh keeps the pages loaded, with the chat
  // at the top
  const moved = server[ME].chats[29]
  moved.session_ts = 1000 * 1_000_000
  await flush(() => onNewMessage({ talkerId: moved.talker_id, sessionType: 1 }))
  assert(current.sessions[0].talker_id === moved.talker_id, 'the chat should move to the top')

  await flush(async () => {
    gate.resolve()
    await loadingMore
  })
  const shown = current.sessions.map(s => s.talker_id)
  assert(
    shown.filter(id => id === moved.talker_id).length === 1 && new Set(shown).size === 250,
    `every chat should show once, got ${shown.length} rows for ${new Set(shown).size} chats`
  )
})

test('a next page asked before a refresh that lists the same chats again still lands', async () => {
  await setup()
  server[ME].chats = Array.from({ length: 150 }, (_, i) => session(1000 + i, i + 1))
  await flush(() => current.fetchSessions())
  const gate = holdList(ME)
  let loadingMore!: Promise<void>
  await flush(() => {
    loadingMore = current.loadMoreSessions()
  })

  // While it's out, a chat on the first page gets a message: the refresh's first page holds the same chats, in
  // another order, and the list still ends where the page was asked from
  const moved = server[ME].chats[100]
  moved.session_ts = 500 * 1_000_000
  await flush(() => onNewMessage({ talkerId: moved.talker_id, sessionType: 1 }))
  assert(current.sessions[0].talker_id === moved.talker_id, 'the chat should move to the top')

  await flush(async () => {
    gate.resolve()
    await loadingMore
  })
  assert(current.sessions.length === 150, `the page should land, got ${current.sessions.length}`)
  assert(new Set(current.sessions.map(s => s.talker_id)).size === 150, 'no chat should show twice')
})

test('removing an account forgets what was kept of it', async () => {
  await setup()
  await flush(() => current.removeAccount(OTHER))

  // Signed in again, it can't load in the background this time
  storedMids = [ME, OTHER]
  failBackgroundLists = true
  await flush(() => current.fetchAccounts())
  await flush(() => current.fetchSessions())
  await flush()
  failBackgroundLists = false

  const gate = holdList(OTHER)
  let switching!: Promise<void>
  await flush(() => {
    switching = current.switchAccount(OTHER)
  })
  assert(current.loading && current.sessions.length === 0, 'nothing kept from before should show')
  await flush(async () => {
    gate.resolve()
    await switching
  })
})

test('signing out shows the next account at once, as kept', async () => {
  await setup()
  const gate = holdList(OTHER)
  let leaving!: Promise<void>
  await flush(() => {
    leaving = current.logout()
  })
  assert(shown() === `${OTHER_FRIEND}`, `the next account should show at once, got ${shown()}`)
  await flush(async () => {
    gate.resolve()
    await leaving
  })
  assert(current.userInfo?.mid === OTHER, 'the next account should be signed in')
})

// On disk, across a relaunch

test('a relaunch shows the account as it was left, then refreshes it', async () => {
  await setup()
  server[ME].chats.push(session(NEWCOMER, 90))
  const gate = holdList(ME)
  await relaunch()

  assert(shown() === `${FRIEND},${FAN},${COLLEAGUE}`, `its lists should show at once, got ${shown()}`)
  assert(!current.initializing && !current.loading, 'neither a spinner nor a skeleton should cover them')
  assert(current.isConnected && current.userInfo?.uname === 'me', 'who it is should show at once')
  assert(current.userCache[FRIEND]?.name === `用户名 ${FRIEND}`, 'names should show at once')

  await flush(() => gate.resolve())
  assert(shown() === `${NEWCOMER},${FRIEND},${FAN},${COLLEAGUE}`, `the lists should refresh behind, got ${shown()}`)
})

test('a chat opened before a relaunch shows at once after it, asking only for what came since', async () => {
  await setup()
  await flush(() => current.selectSession(chatOf(FAN)))
  assert(contents() === '1,2,3', `the chat should load, got ${contents()}`)
  await relaunch()

  server[ME].messages[FAN].push(message(FAN, 4))
  const gate = holdMessages()
  await flush(() => current.selectSession(chatOf(FAN)))
  assert(contents() === '1,2,3' && !current.messagesLoading, `it should show at once, got ${contents()}`)
  assert(
    messageRequests.length === 1 && messageRequests[0].beginSeqno === '3' && messageRequests[0].mid === ME,
    `only what came since should be asked for, as its account, got ${JSON.stringify(messageRequests)}`
  )

  await flush(() => gate.resolve())
  assert(contents() === '1,2,3,4', `what came since should be added, got ${contents()}`)
})

test('after a relaunch, the other accounts show as saved when switched to, with nothing loaded ahead', async () => {
  await setup()
  await relaunch()
  assert(
    !sessionRequests.some(p => p.mid !== undefined),
    `accounts saved on disk shouldn't load in the background, got ${JSON.stringify(sessionRequests)}`
  )

  server[OTHER].chats.push(session(NEWCOMER, 80))
  const gate = holdList(OTHER)
  let switching!: Promise<void>
  await flush(() => {
    switching = current.switchAccount(OTHER)
  })
  assert(shown() === `${OTHER_FRIEND}` && !current.loading, `its lists should show at once, got ${shown()}`)

  await flush(async () => {
    gate.resolve()
    await switching
  })
  assert(shown() === `${NEWCOMER},${OTHER_FRIEND}`, `the lists should refresh behind, got ${shown()}`)
})

test('a relaunch into an account signed out elsewhere moves on to the next, leaving none of the first', async () => {
  await setup()
  // It signed out on Bilibili's side: the login check moves on to the other account
  failOverTo = OTHER
  const gate = holdList(OTHER)
  await relaunch()

  assert(current.userInfo?.mid === OTHER, `the next account should be signed in, got ${current.userInfo?.mid}`)
  assert(current.sessions.length === 0 && current.loading, `its lists should load under a skeleton, got ${shown()}`)

  await flush(() => gate.resolve())
  assert(shown() === `${OTHER_FRIEND}`, `only its own lists should show, got ${shown()}`)
})

test('with 在本机保留聊天记录 off, what was saved is deleted and nothing more is', async () => {
  await setup()
  await flush(() => current.selectSession(chatOf(FAN)))
  assert(disk.size > 0, 'what loaded should be on its way to disk')

  try {
    await flush(() => useSettings.getState().setKeepChatsOnDevice(false))
    assert(disk.size === 0, `turning it off should delete what was saved, left ${[...disk.keys()]}`)

    await relaunch()
    assert(current.sessions.length === 0, 'nothing from before should show')
    await flush(() => current.fetchSessions())
    await flush(() => current.selectSession(chatOf(FAN)))
    assert(contents() === '1,2,3', `the chat should load from Bilibili, got ${contents()}`)
    await relaunch()
    assert(disk.size === 0, `nothing should be saved while it's off, got ${[...disk.keys()]}`)
  } finally {
    // The setting outlives the page, in localStorage
    useSettings.setState({ keepChatsOnDevice: true })
  }
})

// The cache's own rules

test('the lists saved on disk stop after their first sessions, going on from there', async () => {
  const many = Array.from({ length: SAVED_SESSIONS + 50 }, (_, i) => session(1000 + i, 10_000 - i))
  const saved = listsToSave({
    sessions: many,
    hasMoreSessions: false,
    nextEndTs: null,
    unfollowFold: null,
    unfollowed: [session(FAN, 5)],
    unfollowedUnread: 0,
    hasMoreUnfollowed: false,
    unfollowedNextEndTs: null,
    userCache: { 1000: { name: 'kept', face: '' }, [1000 + SAVED_SESSIONS]: { name: 'dropped', face: '' } },
  })
  assert(saved.sessions.length === SAVED_SESSIONS, `only the first should be saved, got ${saved.sessions.length}`)
  assert(
    saved.hasMoreSessions && saved.nextEndTs === many[SAVED_SESSIONS - 1].session_ts,
    'the list should go on from the last saved'
  )
  assert(saved.unfollowed.length === 1 && !saved.hasMoreUnfollowed, 'a short list should be saved as it is')
  assert(
    saved.userCache[1000]?.name === 'kept' && !saved.userCache[1000 + SAVED_SESSIONS],
    'only the names of those listed should be saved'
  )
})

test('merging keeps what was shown, takes the server copy of a message sent from here, and applies recalls', async () => {
  const held = [message(FAN, 1), message(ME, 2), message(FAN, 3)]
  assert(mergeMessages(held, [message(FAN, 3)]) === held, 'nothing new should keep the same list')

  // Sent from here: a stand-in seqno until the server's copy comes
  const sent = message(ME, Date.now(), { msg_key: '9000', timestamp: 4 })
  const withSent = [...held, sent]
  const merged = mergeMessages(withSent, [message(ME, 9, { msg_key: '9000', timestamp: 4 })])
  assert(merged.length === 4 && merged[3].msg_seqno === 9, 'the server copy should replace the stand-in')

  const recalled = mergeMessages(held, [message(FAN, 10, { msg_type: 5, content: '1000' })])
  assert(recalled.find(m => m.msg_seqno === 1)?.msg_status === 1, 'a recall should mark the message it names')
  const late = mergeMessages(recalled, [message(FAN, 1), message(FAN, 3)])
  assert(late === recalled, 'a copy fetched before the recall, landing late, should leave the message recalled')
  const before = mergeMessages([message(FAN, 1), message(FAN, 10, { msg_type: 5, content: '3000' })], [message(FAN, 3)])
  assert(
    before.find(m => m.msg_seqno === 3)?.msg_status === 1,
    'a recall held already should take back the message it names when that lands after it'
  )

  const cancelled = mergeMessages(held, [message(0, 11, { msg_type: 5, content: '3000', sys_cancel: true })])
  assert(!cancelled.some(m => m.msg_seqno === 3), 'a message Bilibili cancelled should go')
})

test('the pages loaded past the first stay only while they still follow on from it', async () => {
  const list = [session(5, 50), session(4, 40), session(3, 30), session(2, 20), session(1, 10)]
  // Chat 2 got a message: a fresh first page of three
  const page = [session(2, 60), session(5, 50), session(4, 40)]
  assert(ids(keepLoadedPages(list, page, true) ?? []) === '2,5,4,3,1', 'the older pages should follow the fresh one')
  assert(keepLoadedPages(list, page, false) === null, 'a first page that is the whole list should replace it')

  const allNew = [session(9, 90), session(8, 80), session(7, 70)]
  assert(keepLoadedPages(list, allNew, true) === null, 'a page of only newer chats leaves what follows unknown')

  const pinned = [session(6, 5, { top_ts: 1 }), ...list]
  assert(keepLoadedPages(pinned, page, true) === null, 'an unpinned chat has no known place among the rest')
})

test('the cache keeps the most recently opened chats within its budget', async () => {
  const cache = new ChatCache(5)
  const chat = (count: number) => ({
    messages: Array.from({ length: count }, (_, i) => message(FAN, i + 1)),
    emojiInfoMap: {},
    syncedSeqno: count,
  })
  cache.set(ME, 'a', chat(2))
  cache.set(ME, 'b', chat(2))
  cache.get(ME, 'a')
  cache.set(OTHER, 'c', chat(2))
  assert(!cache.get(ME, 'b') && cache.get(ME, 'a') && cache.get(OTHER, 'c'), 'the least recently opened should go')

  cache.set(ME, 'huge', chat(10))
  assert(cache.get(ME, 'huge') && !cache.get(ME, 'a'), 'one over the budget alone should still stay')

  cache.set(OTHER, 'd', chat(1))
  cache.forgetAccount(OTHER)
  assert(!cache.get(OTHER, 'd'), "a forgotten account's chats should go")
})

// The session list's search

/** Wait, flushing as it goes, until `ready` says so, or fail after `ms` */
async function until(ready: () => boolean, ms: number, what: string) {
  const start = Date.now()
  while (!ready()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`)
    await flush(() => new Promise(resolve => setTimeout(resolve, 50)))
  }
}

const pause = (ms: number) => flush(() => new Promise(resolve => setTimeout(resolve, ms)))

/** Mount the session list alone, with a way to type into its search box */
function mountList() {
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
  const type = (text: string) =>
    flush(() => {
      const input = container.querySelector('input[type="search"]') as HTMLInputElement
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  return { container, type, text: () => container.textContent ?? '' }
}

const listProps = (props: Partial<Parameters<typeof SessionList>[0]>): Parameters<typeof SessionList>[0] => ({
  sessions: [],
  selectedSession: null,
  loading: false,
  loadingMore: false,
  hasMoreSessions: false,
  isHidden: false,
  isConnected: true,
  userCache: {},
  onSessionClick: () => undefined,
  onLoadMore: () => undefined,
  onRefresh: () => undefined,
  ...props,
})

test('a search loads the rest of the list a page at a time, and stops where a page adds nothing', async () => {
  const asked: number[] = []
  let failNext = false
  const { type, text } = mountList()
  let props!: Parameters<typeof SessionList>[0]
  const render = () => root.render(<SessionList {...props} />)
  const loadMore = async () => {
    asked.push(Date.now())
    const page = asked.length
    props = { ...props, loadingMore: true }
    render()
    await new Promise(resolve => setTimeout(resolve, 0))
    const failed = failNext
    failNext = false
    const more = failed ? [] : Array.from({ length: 2 }, (_, i) => session(10_000 * page + i, 1000 - 10 * page - i))
    props = { ...props, sessions: [...props.sessions, ...more], loadingMore: false, hasMoreSessions: page < 3 }
    render()
  }
  props = listProps({
    sessions: [session(FRIEND, 2000)],
    hasMoreSessions: true,
    // One on the second page is found too
    userCache: { [FRIEND]: { name: '朋友', face: '' }, 20001: { name: '朋友的朋友', face: '' } },
    onLoadMore: () => void loadMore(),
  })
  await flush(render)
  assert(asked.length === 0, 'nothing should load before a search')

  await type('  朋友  ')
  await until(() => asked.length === 3 && !props.loadingMore, SEARCH_PAGE_GAP * 4, 'every page')
  assert(text().includes('2 / 7'), `the search, spaces aside, should find both chats among all 7, got ${text()}`)
  assert(
    asked[1] - asked[0] >= SEARCH_PAGE_GAP - 20 && asked[2] - asked[1] >= SEARCH_PAGE_GAP - 20,
    `pages should be asked for SEARCH_PAGE_GAP apart, got ${asked.map(t => t - asked[0])}`
  )

  // A page that fails stops a search loading
  await type('')
  props = { ...props, sessions: [session(FRIEND, 2000)], hasMoreSessions: true }
  asked.length = 0
  await flush(render)
  assert(asked.length === 0, 'nothing should load without a search')
  failNext = true
  await type('另一个')
  await until(() => asked.length === 1 && !props.loadingMore, SEARCH_PAGE_GAP * 3, 'the first page')
  await pause(SEARCH_PAGE_GAP + 300)
  assert(asked.length === 1, `a page that adds nothing should stop the search loading, got ${asked.length}`)

  // Cleared and typed again, it asks again
  await type('')
  await type('另一个')
  await until(() => asked.length === 2 && !props.loadingMore, SEARCH_PAGE_GAP * 3, 'the page asked again')
})

test("a search goes on to 未关注人消息's pages when the main list's next page adds nothing", async () => {
  let foldedPages = 0
  const { type, text } = mountList()
  let props!: Parameters<typeof SessionList>[0]
  const render = () => root.render(<SessionList {...props} />)
  const fold = (sessions: BilibiliSession[], hasMore: boolean, loadingMore = false) => ({
    sessions,
    unread: 0,
    hasMore,
    loadingMore,
    open: false,
  })
  // Folded away, the main list goes on past a first page that held all of it, so its next page is empty
  const loadMore = async () => {
    props = { ...props, loadingMore: true }
    render()
    await new Promise(resolve => setTimeout(resolve, 0))
    props = { ...props, loadingMore: false, hasMoreSessions: false }
    render()
  }
  const loadMoreFolded = async () => {
    foldedPages++
    const held = props.unfollowed?.sessions ?? []
    props = { ...props, unfollowed: fold(held, true, true) }
    render()
    await new Promise(resolve => setTimeout(resolve, 0))
    props = { ...props, unfollowed: fold([...held, session(NEWCOMER, 100, { is_follow: 0 })], false) }
    render()
  }
  props = listProps({
    sessions: [session(FRIEND, 2000)],
    hasMoreSessions: true,
    userCache: { [NEWCOMER]: { name: '路人', face: '' } },
    unfollowed: fold([session(FAN, 1500, { is_follow: 0 })], true),
    onLoadMore: () => void loadMore(),
    onLoadMoreUnfollowed: () => void loadMoreFolded(),
  })
  await flush(render)

  await type('路人')
  await until(
    () => foldedPages === 1 && !props.unfollowed?.loadingMore,
    SEARCH_PAGE_GAP * 3,
    "未关注人消息's next page"
  )
  assert(text().includes('1 / 3'), `the chat on 未关注人消息's next page should be found, got ${text()}`)
})

test('a search pages the list of an account switched to, though it lists as many chats', async () => {
  const asked: Array<number | null | undefined> = []
  const { type, text } = mountList()
  let props!: Parameters<typeof SessionList>[0]
  const render = () => root.render(<SessionList {...props} />)
  // This account's next page fails, adding nothing; the other account's next page holds the chat
  const loadMore = async () => {
    const mid = props.activeAccountMid
    asked.push(mid)
    props = { ...props, loadingMore: true }
    render()
    await new Promise(resolve => setTimeout(resolve, 0))
    const more = mid === OTHER ? [session(NEWCOMER, 100)] : []
    props = { ...props, sessions: [...props.sessions, ...more], loadingMore: false, hasMoreSessions: mid !== OTHER }
    render()
  }
  props = listProps({
    activeAccountMid: ME,
    sessions: [session(FRIEND, 2000), session(FAN, 1500)],
    hasMoreSessions: true,
    userCache: { [NEWCOMER]: { name: '路人', face: '' } },
    onLoadMore: () => void loadMore(),
  })
  await flush(render)
  await type('路人')
  await until(() => asked.length === 1 && !props.loadingMore, SEARCH_PAGE_GAP * 2, "this account's next page")

  props = { ...props, activeAccountMid: OTHER, sessions: [session(COLLEAGUE, 3000), session(OTHER_FRIEND, 2500)] }
  await flush(render)
  await until(() => asked.length === 2 && !props.loadingMore, SEARCH_PAGE_GAP * 3, "the other account's next page")
  assert(asked[1] === OTHER && text().includes('1 / 3'), `the other account's chat should be found, got ${text()}`)
})

test("while the messages held are searched, the list says it's searching, not that nothing matched", async () => {
  const held = deferred<Map<string, MessageMatch>>()
  const { type, text } = mountList()
  root.render(
    <SessionList
      {...listProps({
        sessions: [session(FRIEND, 2000)],
        userCache: { [FRIEND]: { name: '朋友', face: '' } },
        onSearchMessages: () => held.promise,
      })}
    />
  )
  await flush()
  await type('早前')
  await pause(300)
  assert(!text().includes('没有找到匹配的会话'), `it shouldn't say nothing matched before it knows, got ${text()}`)
  await flush(() => held.resolve(new Map([[`1:${FRIEND}`, { msgKey: '1000', text: '早前的话' }]])))
  await until(() => text().includes('1 / 1'), 2000, 'the chat found by a message held of it')
})

test('from the main list, a search looks through 未关注人消息 too, loading its pages after the main list', async () => {
  let foldedPages = 0
  const { type, text } = mountList()
  let props!: Parameters<typeof SessionList>[0]
  const render = () => root.render(<SessionList {...props} />)
  const fold = (sessions: BilibiliSession[], hasMore: boolean, loadingMore = false) => ({
    sessions,
    unread: 0,
    hasMore,
    loadingMore,
    open: false,
  })
  const loadMoreFolded = async () => {
    foldedPages++
    const held = props.unfollowed?.sessions ?? []
    props = { ...props, unfollowed: fold(held, true, true) }
    render()
    await new Promise(resolve => setTimeout(resolve, 0))
    props = { ...props, unfollowed: fold([...held, session(NEWCOMER, 100, { is_follow: 0 })], false) }
    render()
  }
  props = listProps({
    sessions: [session(FRIEND, 2000)],
    userCache: {
      [FRIEND]: { name: '朋友', face: '' },
      [FAN]: { name: '粉丝', face: '' },
      [NEWCOMER]: { name: '路人', face: '' },
    },
    unfollowed: fold([session(FAN, 1500, { is_follow: 0 })], true),
    onLoadMoreUnfollowed: () => void loadMoreFolded(),
  })
  await flush(render)

  // The list draws no rows in a hidden window, but its count shows what the search found among how many
  await type('粉丝')
  await until(() => foldedPages === 1 && !props.unfollowed?.loadingMore, SEARCH_PAGE_GAP * 3, '未关注人消息 to load')
  assert(text().includes('1 / 3'), `a chat folded into 未关注人消息 should be found from the main list, got ${text()}`)
  await type('路人')
  assert(text().includes('1 / 3'), `a chat on 未关注人消息's next page should be found among all 3, got ${text()}`)
  await type('没有这个人')
  assert(text().includes('没有找到匹配的会话'), `text no chat holds should find none, got ${text()}`)
})

test('a search finds a chat by an earlier message held of it, and shows that message in place of its last', async () => {
  const asked: string[] = []
  const friend = session(FRIEND, 2000, { last_msg: message(FRIEND, 9, said('最后一句')) })
  const fan = session(FAN, 1000, { last_msg: message(FAN, 8, said('asdaf 也是最后一句')) })
  const userCache = { [FRIEND]: { name: '朋友', face: '' }, [FAN]: { name: '粉丝', face: '' } }
  const held = new Map([
    [`1:${FRIEND}`, { msgKey: '3000', text: '早前的 asdaf 消息' }],
    [`1:${FAN}`, { msgKey: '4000', text: '早前的 asdaf' }],
  ])
  const { type, text } = mountList()
  root.render(
    <SessionList
      {...listProps({
        sessions: [friend, session(COLLEAGUE, 1500)],
        userCache,
        onSearchMessages: async query => {
          asked.push(query)
          return query === 'Asdaf' ? held : new Map()
        },
      })}
    />
  )
  await flush()

  await type('Asdaf')
  await until(() => text().includes('1 / 2'), 2000, 'the chat found by a message held of it')
  assert(asked.at(-1) === 'Asdaf', `the messages held should be searched for the text typed, got ${asked}`)

  // The message it was found by shows in place of its last, unless what the list shows of it holds the text already
  assert(searchMatch(friend, 'Asdaf', userCache, held)?.text === '早前的 asdaf 消息', 'the held message should show')
  assert(searchMatch(fan, 'Asdaf', userCache, held) === undefined, 'its own last message should show')
  root.render(
    <SessionItem
      session={friend}
      draftKey=''
      isSelected={false}
      userCache={userCache}
      preview='早前的 asdaf 消息'
      onClick={() => undefined}
    />
  )
  await flush()
  assert(
    text().includes('早前的 asdaf 消息') && !text().includes('最后一句'),
    `the row should show the message in place of its last, got ${text()}`
  )
})

// The list draws rows in a hidden window only at the sizes Virtuoso is told
const drawn = { viewportHeight: 600, itemHeight: 60 }

test('a search result found by an earlier message opens the chat at it, and one found otherwise at its newest', async () => {
  const opened: Array<[number, string | undefined]> = []
  const userCache = { [FRIEND]: { name: '朋友', face: '' }, [FAN]: { name: 'asdaf 粉丝', face: '' } }
  const { type, container } = mountList()
  root.render(
    <VirtuosoMockContext.Provider value={drawn}>
      <SessionList
        {...listProps({
          sessions: [session(FRIEND, 2000), session(FAN, 1500)],
          userCache,
          onSessionClick: (s, msgKey) => opened.push([s.talker_id, msgKey]),
          onSearchMessages: async () =>
            new Map([
              [`1:${FRIEND}`, { msgKey: '3000', text: '早前的 asdaf 消息' }],
              [`1:${FAN}`, { msgKey: '4000', text: '粉丝说的 asdaf' }],
            ]),
        })}
      />
    </VirtuosoMockContext.Provider>
  )
  await flush()
  await type('asdaf')
  const row = (name: string) =>
    [...container.querySelectorAll('button')].find(b => b.textContent?.includes(name)) as HTMLButtonElement | undefined
  await until(() => !!row('早前的 asdaf 消息'), 2000, 'the chat found by an earlier message')
  await flush(() => row('早前的 asdaf 消息')?.click())
  await flush(() => row('asdaf 粉丝')?.click())
  const got = opened.map(([talkerId, msgKey]) => `${talkerId} at ${msgKey ?? 'its newest'}`).join(', ')
  assert(
    got === `${FRIEND} at 3000, ${FAN} at its newest`,
    `the one found by an earlier message should open at it, the one found by its name at its newest, got ${got}`
  )
})

test('a chat opens at the message it was opened at, centered and marked, and otherwise at its newest', async () => {
  const messages = Array.from({ length: 300 }, (_, i) => message(i % 2 ? ME : FAN, i + 1))
  const container = document.createElement('div')
  // The page has no stylesheet, so the list is given the height the app's layout gives it
  const height = document.createElement('style')
  height.textContent = `[data-virtuoso-scroller] { height: ${drawn.viewportHeight}px !important }`
  document.body.replaceChildren(height, container)
  root = createRoot(container)
  const panel = (chatOpening: ChatOpening) => (
    <VirtuosoMockContext.Provider value={drawn}>
      <MessagesPanel
        selectedSession={session(FAN, 300)}
        chatOpening={chatOpening}
        messages={messages}
        emojiInfoMap={{}}
        messagesLoading={false}
        sendingMessage={false}
        isVisible
        userCache={{}}
        userInfo={{ isLogin: true, mid: ME, uname: 'me' }}
        onBack={() => undefined}
        onSendMessage={async () => true}
        onSendImage={async () => true}
        onRecall={async () => ({ success: true })}
        onToggleDnd={async () => true}
        onToggleSticky={async () => true}
        customerServiceSessions={[]}
        activeCustomerService={null}
        onSelectCustomerService={() => undefined}
        onCustomerServiceReply={async () => true}
      />
    </VirtuosoMockContext.Provider>
  )
  const rows = () => [...container.querySelectorAll('[data-index]')].map(e => Number(e.getAttribute('data-index')))
  const marked = () => [...container.querySelectorAll('[data-target]')].map(e => e.textContent)
  const showsAround = (index: number) => rows().includes(index) && !rows().includes(messages.length - 1)
  // Each opening mounts the list again, which draws its rows a few frames later
  const open = async (chatOpening: ChatOpening) => {
    await flush(() => root.render(panel(chatOpening)))
    await until(() => rows().length > 0, 2000, 'the messages to show')
  }
  const scroller = () => container.querySelector('[data-virtuoso-scroller]')

  await open({ msgKey: '100000', id: 1 })
  assert(showsAround(99), `it should open at the message, got rows ${rows()}`)
  assert(
    rows().some(i => i < 99) && rows().some(i => i > 99),
    `the message should show among those around it, got rows ${rows()}`
  )
  assert(marked().length === 1 && marked()[0]?.includes('消息 100'), `the message should be marked, got ${marked()}`)

  await open({ msgKey: null, id: 2 })
  assert(rows().includes(messages.length - 1), `opened otherwise, it should open at its newest, got rows ${rows()}`)
  assert(marked().length === 0, `nothing should be marked, got ${marked()}`)

  // Opened again, from wherever it was scrolled to, it opens anew
  const shown = scroller()
  await open({ msgKey: null, id: 3 })
  assert(scroller() !== shown, 'opening it again should open it anew, at its newest')

  await open({ msgKey: '100000', id: 4 })
  assert(showsAround(99), `opened at the message again, it should go back there, got rows ${rows()}`)

  // A message it doesn't hold (gone since) leaves it at its newest
  await open({ msgKey: '999000', id: 5 })
  assert(rows().includes(messages.length - 1), `it should open at its newest, got rows ${rows()}`)
})

void (async () => {
  const report: typeof globals.__rendererTestResults = { tests: [] }
  for (const { name, run } of tests) {
    try {
      await run()
      report.tests.push({ name, ok: true })
    } catch (error) {
      report.tests.push({ name, ok: false, error: error instanceof Error ? error.stack : String(error) })
    } finally {
      if (root) await flush(() => root.unmount())
    }
  }
  globals.__rendererTestResults = report
})()
