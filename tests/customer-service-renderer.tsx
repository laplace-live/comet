import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type {
  BilibiliMessage,
  BilibiliMessagesResponse,
  BilibiliSession,
  BilibiliSessionsResponse,
  BilibiliUserCardsResponse,
  CustomerServiceMessage,
  CustomerServiceMessagesResponse,
  CustomerServiceParticipant,
  CustomerServiceSendMessageResponse,
  CustomerServiceSession,
} from '@/types/bilibili'
import type {
  CustomerServiceShop,
  ErrorResponse,
  FetchCustomerServiceMessagesParams,
  FetchUsersParams,
  NavigateToSessionParams,
  NewMessageNotification,
  SendCustomerServiceMessageParams,
  ShowNotificationParams,
  UploadImageResult,
} from '@/types/electron'

import { CS_MSG_TYPE, CS_SENDER_TYPE, SYSTEM_MSG_TYPE } from '@/types/bilibili'

import { getCustomerServicePreview, parseCustomerServiceContent, toDisplayMessage } from '@/lib/customer-service'

import { type UsePrivateMessagesReturn, usePrivateMessages } from '@/hooks/usePrivateMessages'

import { MessageBubble } from '@/components/comet/MessageBubble'

import { getDraftKey, getSessionDraft } from '@/stores/useDrafts'
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
const FRIEND = 456
// Another account of the user's, which talks to the same people
const OTHER_ACCOUNT = 789

function session(overrides: Partial<BilibiliSession>): BilibiliSession {
  return {
    talker_id: 0,
    session_type: 1,
    at_seqno: 0,
    top_ts: 0,
    group_name: '',
    group_cover: '',
    is_follow: 0,
    is_dnd: 0,
    ack_seqno: 0,
    ack_ts: 0,
    session_ts: 0,
    unread_count: 0,
    last_msg: null,
    group_type: 0,
    can_fold: 0,
    status: 0,
    max_seqno: 0,
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

function message(senderUid: number, text: string, ts: number): BilibiliMessage {
  return {
    sender_uid: senderUid,
    receiver_type: 1,
    receiver_id: senderUid === ME ? FRIEND : ME,
    msg_type: 1,
    content: JSON.stringify({ content: text }),
    msg_seqno: ts,
    timestamp: ts,
    at_uids: null,
    msg_key: ts,
    msg_status: 0,
    notify_code: '',
    msg_source: 0,
  }
}

function instantMsg(senderUid: number, text: string): NewMessageNotification['instantMsg'] {
  return {
    senderUid,
    receiverType: 1,
    receiverId: senderUid === ME ? FRIEND : ME,
    msgType: 1,
    content: JSON.stringify({ content: text }),
    msgSeqno: 2,
    timestamp: 2,
    msgKey: '2',
  }
}

// 客服消息 as get_sessions lists it, after its latest message at `ts`
function customerService(unread: number, ts: number, text: string): BilibiliSession {
  return session({
    is_follow: 1,
    system_msg_type: SYSTEM_MSG_TYPE.CUSTOMER_SERVICE,
    account_info: { name: '客服消息', pic_url: 'https://i0.hdslb.com/bfs/face/customer-service.png' },
    unread_count: unread,
    session_ts: ts,
    last_msg: message(0, text, ts),
  })
}

const friend = session({ talker_id: FRIEND, session_ts: 1 })
// Customer service notifications name a store (or 0 for Bilibili's own), never the folded session
const customerServiceNotification: NewMessageNotification = { talkerId: 0, sessionType: 3 }

// The customer service backend: its chats and messages, as customerservice.bilibili.com sends them
function participant(type: number, uid: number, name: string): CustomerServiceParticipant {
  return {
    type,
    uid,
    shop_id: 0,
    shop_father_id: 0,
    customer_id: 0,
    machine_session_id: 0,
    customer_session_id: 0,
    name,
    pic_url: `https://i0.hdslb.com/bfs/face/${uid}.png`,
    shop_homepage: '',
  }
}
const BOT = participant(CS_SENDER_TYPE.MACHINE, 0, '智能小助手')
const USER = participant(CS_SENDER_TYPE.USER, ME, 'me')

// seq is small here; real seqnos exceed Number.MAX_SAFE_INTEGER, so they travel as strings
function csMessage(sender: CustomerServiceParticipant, text: string, seq: number): CustomerServiceMessage {
  return {
    sender_info: sender,
    receiver_info: sender === USER ? BOT : USER,
    msg_type: CS_MSG_TYPE.TEXT,
    content: JSON.stringify({ content: text }),
    msg_key: `90000000000000000${seq}`,
    seq_no: `80000000000000000${seq}`,
    timestamp: seq,
    msg_status: 0,
    msg_source: 6,
  }
}

function csSession(
  shop: CustomerServiceShop,
  name: string,
  unread = 0,
  lastMsg: CustomerServiceMessage | null = null
): CustomerServiceSession {
  return {
    talker_info: {
      ...participant(CS_SENDER_TYPE.CUSTOMER, 0, name),
      shop_father_id: shop.shopFatherId,
      shop_id: shop.shopId,
    },
    last_msg: lastMsg,
    unread_info: { unread_count: unread },
    session_ts: 1,
    max_seqno: '0',
    top_set: 0,
    do_not_disturb: false,
    tag_name: '',
  }
}

/** One page, newest first, like fetch_sess_msg */
function csPage(messages: CustomerServiceMessage[], hasMore = false): CustomerServiceMessagesResponse {
  return {
    code: 0,
    message: '0',
    data: {
      messages,
      has_more: hasMore ? 1 : 0,
      min_seqno: messages.at(-1)?.seq_no ?? '0',
      max_seqno: messages[0]?.seq_no ?? '0',
    },
  }
}

const BILIBILI_SHOP: CustomerServiceShop = { shopFatherId: 0, shopId: 0 }
const STORE_SHOP: CustomerServiceShop = { shopFatherId: 1, shopId: 9 }

let current: UsePrivateMessagesReturn
let root!: Root
let serverSessions: BilibiliSession[]
let fetchSessionsImpl: () => Promise<BilibiliSessionsResponse>
let onNewMessage: (notification: NewMessageNotification) => void
let shown: ShowNotificationParams[]
let setDndCalls: number
let badge: number
let customerServiceSessions: CustomerServiceSession[]
// Holds the chat list back until resolved, for requests that are still out when the user moves on
let customerServiceSessionsGate: Promise<unknown>
let fetchCustomerServiceMessagesImpl: (
  params: FetchCustomerServiceMessagesParams
) => Promise<CustomerServiceMessagesResponse | ErrorResponse>
let sendCustomerServiceMessageImpl: () => Promise<CustomerServiceSendMessageResponse>
let uploadImageImpl: () => Promise<UploadImageResult>
let fetchDirectMessagesImpl: () => Promise<BilibiliMessagesResponse>
// What clicking a notification calls
let navigate: (params: NavigateToSessionParams) => void
let customerServiceCalls: {
  fetchMessages: FetchCustomerServiceMessagesParams[]
  sendMessage: SendCustomerServiceMessageParams[]
  updateAck: CustomerServiceShop[]
}
let directCalls: { fetchMessages: number; sendMessage: number }
// The account checkLogin signs in as; switching accounts changes it
let signedInMid: number

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

const sessionsResponse = (): BilibiliSessionsResponse => ({
  code: 0,
  msg: '0',
  message: '0',
  ttl: 1,
  data: {
    session_list: serverSessions,
    has_more: 0,
    anti_disturb_cleaning: false,
    is_address_list_empty: 0,
    show_level: false,
  },
})

/** One page of a direct conversation, newest first */
function directPage(messages: BilibiliMessage[]): BilibiliMessagesResponse {
  return { code: 0, msg: '0', message: '0', ttl: 1, data: { messages, has_more: 0, min_seqno: 1, max_seqno: 1 } }
}

async function setup(initialSessions: BilibiliSession[]) {
  serverSessions = initialSessions
  fetchSessionsImpl = async () => sessionsResponse()
  shown = []
  setDndCalls = 0
  badge = -1
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服')]
  customerServiceSessionsGate = Promise.resolve()
  fetchCustomerServiceMessagesImpl = async () => csPage([])
  sendCustomerServiceMessageImpl = async () => ({ code: 0, message: '0', data: { msg_key: '900000000000000099' } })
  uploadImageImpl = async () => ({ success: true, url: 'https://i0.hdslb.com/bfs/im/image.png', width: 1, height: 1 })
  // A lookup of the notified chat finds someone else's message, which a sender check would trust
  fetchDirectMessagesImpl = async () => directPage([message(0, '您好，请问有什么可以帮您？', 1)])
  customerServiceCalls = { fetchMessages: [], sendMessage: [], updateAck: [] }
  directCalls = { fetchMessages: 0, sendMessage: 0 }
  signedInMid = ME
  useSettings.setState({ customerServiceMutedMids: [] })
  window.electronAPI = {
    setBadgeCount: async (count: number) => {
      badge = count
      return { success: true }
    },
    bilibili: {
      getAccounts: async () => ({ accounts: [{ mid: ME, uname: 'me', isExpired: false }], activeAccountMid: ME }),
      checkLogin: async () => ({ isLogin: true, mid: signedInMid, uname: 'me' }),
      setActiveAccount: async ({ mid }: { mid: number }) => {
        signedInMid = mid
        return { success: true }
      },
      wsDisconnect: async () => ({ success: true }),
      fetchSessions: () => fetchSessionsImpl(),
      fetchMessages: () => {
        directCalls.fetchMessages++
        return fetchDirectMessagesImpl()
      },
      sendMessage: async () => {
        directCalls.sendMessage++
        return { code: 0, message: '0', data: { msg_key: '1' } }
      },
      customerService: {
        fetchSessions: async () => {
          await customerServiceSessionsGate
          return { code: 0, message: '0', data: { session_list: customerServiceSessions, has_more: 0 } }
        },
        fetchMessages: (params: FetchCustomerServiceMessagesParams) => {
          customerServiceCalls.fetchMessages.push(params)
          return fetchCustomerServiceMessagesImpl(params)
        },
        sendMessage: async (params: SendCustomerServiceMessageParams) => {
          customerServiceCalls.sendMessage.push(params)
          // As the main process does, it sends only from the account signed in
          if (params.senderMid !== signedInMid) return { error: 'The account changed', code: 409 }
          return sendCustomerServiceMessageImpl()
        },
        uploadImage: () => uploadImageImpl(),
        updateAck: async (shop: CustomerServiceShop) => {
          customerServiceCalls.updateAck.push(shop)
          return { code: 0 }
        },
      },
      fetchUsers: async ({ uids }: FetchUsersParams): Promise<BilibiliUserCardsResponse> => ({
        code: 0,
        msg: '0',
        message: '0',
        ttl: 1,
        data: uids.split(',').map(uid => ({
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
      }),
      setDnd: async () => {
        setDndCalls++
        return { success: true }
      },
      showNotification: async (params: ShowNotificationParams) => {
        shown.push(params)
        return { shown: true }
      },
      wsConnect: async () => ({ success: true }),
      onNewMessage: (callback: (notification: NewMessageNotification) => void) => {
        onNewMessage = callback
        return () => undefined
      },
      onSessionUpdate: () => () => undefined,
      onWsConnected: () => () => undefined,
      onWsDisconnected: () => () => undefined,
      onNavigateToSession: (callback: (params: NavigateToSessionParams) => void) => {
        navigate = callback
        return () => undefined
      },
    },
  } as unknown as typeof window.electronAPI
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
  await flush(() => root.render(<Harness />))
  // The user is looking at Comet unless a test says otherwise (the test window itself is hidden)
  await flush(() => window.dispatchEvent(new Event('focus')))
  assert(current.userInfo?.mid === ME, 'the harness should log in')
  await flush(() => current.fetchSessions())
}

async function notify(notification: NewMessageNotification, nextSessions: BilibiliSession[]) {
  serverSessions = nextSessions
  await flush(() => onNewMessage(notification))
}

function displayedCustomerService(): BilibiliSession {
  const listed = current.sessions.find(s => s.system_msg_type === SYSTEM_MSG_TYPE.CUSTOMER_SERVICE)
  if (!listed) throw new Error('客服消息 should be listed')
  return listed
}

/** Texts of the messages shown, oldest first */
const shownTexts = () => current.messages.map(m => JSON.parse(m.content).content)

async function openCustomerServiceChat(page: CustomerServiceMessage[]) {
  await setup([customerService(1, 1, '已为您转接人工客服')])
  fetchCustomerServiceMessagesImpl = async () => csPage(page)
  await flush(() => current.selectSession(displayedCustomerService()))
}

const tests: Array<{ name: string; run: () => Promise<void> }> = []
function test(name: string, run: () => Promise<void>) {
  tests.push({ name, run })
}

test("the user's own customer service message does not notify", async () => {
  await setup([customerService(0, 1, '您好，请问有什么可以帮您？')])
  // 客服消息 counts an older reply as unread, but the chat says who sent its latest message
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服', 1, csMessage(USER, '我想咨询一下', 2))]
  // Neither a message lookup nor an instant message that names someone else may count as a reply
  await notify(customerServiceNotification, [customerService(1, 2, '我想咨询一下')])
  await notify({ ...customerServiceNotification, instantMsg: instantMsg(0, '我想咨询一下') }, [
    customerService(1, 3, '我想咨询一下'),
  ])
  assert(shown.length === 0, `the user's own message must not notify, got ${shown.length}`)
  assert(displayedCustomerService().session_ts === 3, 'the notifications should still refresh 客服消息')
})

test('a customer service reply notifies once as 客服消息', async () => {
  await setup([customerService(0, 1, '我想咨询一下')])
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服', 1, csMessage(BOT, '已为您转接人工客服', 2))]
  await notify(customerServiceNotification, [customerService(1, 2, '已为您转接人工客服')])
  assert(shown.length === 1, 'a reply from someone else should notify')
  const [notification] = shown
  assert(notification.title === '客服消息', `title should name 客服消息, got ${notification.title}`)
  assert(notification.body === '已为您转接人工客服', `body should be the reply, got ${notification.body}`)
  assert(notification.icon === 'https://i0.hdslb.com/bfs/face/customer-service.png', 'icon should be its avatar')
  assert(notification.talkerId === 0 && notification.sessionType === 1, 'a click should open 客服消息')
  assert(notification.customerServiceShop?.shopId === BILIBILI_SHOP.shopId, 'a click should open the chat that replied')
})

test('overlapping notifications for one reply notify once', async () => {
  await setup([customerService(0, 1, '我想咨询一下')])
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服', 1, csMessage(BOT, '机器人自动回复', 3))]
  const pending = deferred<BilibiliSessionsResponse>()
  fetchSessionsImpl = () => pending.promise
  serverSessions = [customerService(1, 3, '机器人自动回复')]
  await flush(() => {
    // The user's message and the bot's instant reply, both refreshed after the reply landed
    onNewMessage(customerServiceNotification)
    onNewMessage(customerServiceNotification)
  })
  await flush(() => pending.resolve(sessionsResponse()))
  assert(shown.length === 1, `one reply should notify once, got ${shown.length}`)
})

test("a reply notifies before 客服消息 is listed, and the user's own message still doesn't", async () => {
  // 客服消息 sorts past the sessions loaded so far, with replies left unread
  await setup([friend])
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服', 2, csMessage(USER, '我在手机上发的', 3))]
  await notify(customerServiceNotification, [customerService(2, 3, '我在手机上发的'), friend])
  assert(shown.length === 0, `the user's own message from another device must not notify, got ${shown.length}`)

  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服', 3, csMessage(BOT, '已收到您的反馈', 4))]
  await notify(customerServiceNotification, [customerService(3, 4, '已收到您的反馈'), friend])
  assert(shown.length === 1 && shown[0].body === '已收到您的反馈', 'the reply should notify')
})

test('clicking a customer service notification opens the chat that replied', async () => {
  await setup([customerService(0, 1, '您好'), friend])
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服'), csSession(STORE_SHOP, '会员购店铺')]
  fetchCustomerServiceMessagesImpl = async ({ shopId }) =>
    csPage([csMessage(BOT, shopId === STORE_SHOP.shopId ? '您的订单已发货' : '哔哩哔哩客服的旧消息', 1)])
  // The user read Bilibili's own chat, then moved on
  await flush(() => current.selectSession(displayedCustomerService()))
  await flush(() => current.selectSession(friend))

  customerServiceSessions = [
    csSession(STORE_SHOP, '会员购店铺', 1, csMessage(BOT, '您的订单已发货', 2)),
    csSession(BILIBILI_SHOP, '哔哩哔哩客服'),
  ]
  await notify({ talkerId: STORE_SHOP.shopId, sessionType: 4 }, [customerService(1, 2, '您的订单已发货'), friend])
  const [notification] = shown
  assert(notification?.body === '您的订单已发货', `the store's reply should notify, got ${notification?.body}`)
  await flush(() => navigate(notification))

  assert(current.activeCustomerService?.talker_info.name === '会员购店铺', 'the store chat should open')
  assert(shownTexts().join('|') === '您的订单已发货', `the reply should show, got ${shownTexts()}`)
})

test('muting 客服消息 stays local and silences it', async () => {
  await setup([customerService(2, 1, '已为您转接人工客服'), friend])
  await flush(async () => assert(await current.toggleDnd(displayedCustomerService(), true), 'muting should succeed'))
  assert(setDndCalls === 0, 'set_msg_dnd cannot target 客服消息 and must not be called')
  assert(useSettings.getState().customerServiceMutedMids.includes(ME), 'the mute should be kept for this account')
  assert(badge === 0, `muted unread must leave the badge, got ${badge}`)

  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服', 3, csMessage(BOT, '请问还有其他问题吗？', 2))]
  await notify(customerServiceNotification, [customerService(3, 2, '请问还有其他问题吗？'), friend])
  assert(shown.length === 0, 'a muted reply must not notify')
  assert(displayedCustomerService().is_dnd === 1, 'the mute should survive a refresh')

  await flush(async () => assert(await current.toggleDnd(displayedCustomerService(), false), 'unmuting should succeed'))
  assert(displayedCustomerService().is_dnd === 0 && badge === 3, 'unmuting should restore the session')
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服', 4, csMessage(BOT, '感谢您的耐心等待', 3))]
  await notify(customerServiceNotification, [customerService(4, 3, '感谢您的耐心等待'), friend])
  assert(shown.length === 1, 'an unmuted reply should notify again')
})

test("muting 客服消息 while a reply's notification is on its way silences it", async () => {
  await setup([customerService(0, 1, '您好')])
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服', 1, csMessage(BOT, '请问还有其他问题吗？', 2))]
  const refresh = deferred<BilibiliSessionsResponse>()
  fetchSessionsImpl = () => refresh.promise
  serverSessions = [customerService(1, 2, '请问还有其他问题吗？')]

  await flush(() => onNewMessage(customerServiceNotification))
  await flush(async () => assert(await current.toggleDnd(displayedCustomerService(), true), 'muting should succeed'))
  await flush(() => refresh.resolve(sessionsResponse()))

  assert(shown.length === 0, `a reply muted before it notified must not notify, got ${shown.length}`)
})

test("a reply for the last account doesn't notify once another account signs in", async () => {
  await setup([customerService(0, 1, '您好')])
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服', 1, csMessage(BOT, '请问还有其他问题吗？', 2))]
  const refresh = deferred<BilibiliSessionsResponse>()
  fetchSessionsImpl = () => refresh.promise
  serverSessions = [customerService(1, 2, '请问还有其他问题吗？')]

  await flush(() => onNewMessage(customerServiceNotification))
  fetchSessionsImpl = async () => sessionsResponse()
  await flush(() => current.switchAccount(OTHER_ACCOUNT))
  await flush(() => refresh.resolve(sessionsResponse()))

  assert(shown.length === 0, `the last account's reply must not notify, got ${shown.length}`)
})

test("a reply that notified doesn't notify again after another chat's", async () => {
  await setup([customerService(0, 1, '您好')])
  const bilibili = csSession(BILIBILI_SHOP, '哔哩哔哩客服', 1, csMessage(BOT, '已为您转接人工客服', 2))
  customerServiceSessions = [bilibili]
  await notify(customerServiceNotification, [customerService(1, 2, '已为您转接人工客服')])
  customerServiceSessions = [csSession(STORE_SHOP, '会员购店铺', 1, csMessage(BOT, '您的订单已发货', 3)), bilibili]
  await notify({ talkerId: STORE_SHOP.shopId, sessionType: 4 }, [customerService(2, 3, '您的订单已发货')])
  // A late one for Bilibili's chat, whose reply is still its latest
  await notify(customerServiceNotification, [customerService(2, 3, '您的订单已发货')])

  const bodies = shown.map(notification => notification.body).join('|')
  assert(bodies === '已为您转接人工客服|您的订单已发货', `each reply should notify once, got ${bodies}`)
})

test('direct messages still notify, except your own', async () => {
  await setup([friend])
  const direct = (senderUid: number, text: string): NewMessageNotification => ({
    talkerId: FRIEND,
    sessionType: 1,
    instantMsg: instantMsg(senderUid, text),
  })
  await notify(direct(ME, '我先发一条'), [friend])
  assert(shown.length === 0, 'your own direct message must not notify')
  await notify(direct(FRIEND, '晚上好'), [friend])
  assert(shown.length === 1 && shown[0].title === `用户名 ${FRIEND}`, 'a direct message should notify by sender')
  assert(shown[0].body === '晚上好', `body should be the message, got ${shown[0].body}`)
})

test('opening 客服消息 shows its customer service chat, every page of it', async () => {
  await setup([customerService(1, 1, '已为您转接人工客服')])
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服', 1)]
  const pages: Record<string, CustomerServiceMessage[]> = {
    newest: [csMessage(BOT, '已为您转接人工客服', 4), csMessage(USER, '人工', 3)],
    [csMessage(USER, '人工', 3).seq_no]: [csMessage(BOT, '请问有什么可以帮您？', 2), csMessage(USER, '你好', 1)],
  }
  fetchCustomerServiceMessagesImpl = async ({ endSeqno }) =>
    endSeqno ? csPage(pages[endSeqno]) : csPage(pages.newest, true)

  await flush(() => current.selectSession(displayedCustomerService()))

  const asked = customerServiceCalls.fetchMessages.map(params => params.endSeqno)
  assert(asked.length === 2 && asked[1] === csMessage(USER, '人工', 3).seq_no, `should page back, asked ${asked}`)
  assert(
    shownTexts().join('|') === '你好|请问有什么可以帮您？|人工|已为您转接人工客服',
    `messages should run oldest first, got ${shownTexts()}`
  )
  assert(current.messages[0].sender_uid === ME && current.messages[1].sender_uid === 0, 'senders should map')
  assert(directCalls.fetchMessages === 0, '客服消息 has no direct messages to fetch')
  assert(current.activeCustomerService?.talker_info.name === '哔哩哔哩客服', 'the chat should be the one listed')
  assert(customerServiceCalls.updateAck.length === 1 && customerServiceCalls.updateAck[0].shopId === 0, 'should ack')
  assert(displayedCustomerService().unread_count === 0, '客服消息 should be read')
})

test('a reply to the open customer service chat appears without reopening it', async () => {
  const opening = [csMessage(BOT, '请问有什么可以帮您？', 2), csMessage(USER, '你好', 1)]
  await openCustomerServiceChat(opening)
  fetchCustomerServiceMessagesImpl = async () => csPage([csMessage(BOT, '已为您查询', 3), ...opening])

  await notify(customerServiceNotification, [customerService(1, 3, '已为您查询')])

  assert(
    shownTexts().join('|') === '你好|请问有什么可以帮您？|已为您查询',
    `reply should append once, got ${shownTexts()}`
  )
})

test('sending in 客服消息 goes to customer service, and the server copy is not doubled', async () => {
  await openCustomerServiceChat([csMessage(BOT, '请问有什么可以帮您？', 1)])

  await flush(async () => assert(await current.sendMessage('如何申请退票？'), 'send should succeed'))

  const [sent] = customerServiceCalls.sendMessage
  assert(
    sent?.shopFatherId === 0 && sent.shopId === 0 && sent.msgType === CS_MSG_TYPE.TEXT,
    'should send to the chat on screen'
  )
  assert(JSON.parse(sent.content).content === '如何申请退票？', 'should send the text')
  assert(directCalls.sendMessage === 0, 'must not send a direct message to talker 0')
  assert(current.messages.at(-1)?.sender_uid === ME, 'the message should show as sent')

  const serverCopy = { ...csMessage(USER, '如何申请退票？', 2), msg_key: '900000000000000099' }
  fetchCustomerServiceMessagesImpl = async () =>
    csPage([csMessage(BOT, '您可以在订单页申请', 3), serverCopy, csMessage(BOT, '请问有什么可以帮您？', 1)])
  await notify(customerServiceNotification, [customerService(1, 3, '您可以在订单页申请')])

  assert(
    shownTexts().join('|') === '请问有什么可以帮您？|如何申请退票？|您可以在订单页申请',
    `the sent message should show once, got ${shownTexts()}`
  )
})

test('switching customer service chats drops a late reply for the one left', async () => {
  await setup([customerService(1, 1, '您好')])
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服'), csSession(STORE_SHOP, '会员购店铺', 2)]
  const slow = deferred<CustomerServiceMessagesResponse>()
  fetchCustomerServiceMessagesImpl = async ({ shopId }) =>
    shopId === BILIBILI_SHOP.shopId ? slow.promise : csPage([csMessage(BOT, '您的订单已发货', 1)])

  await flush(() => current.selectSession(displayedCustomerService()))
  await flush(() => current.selectCustomerService(STORE_SHOP))
  await flush(() => slow.resolve(csPage([csMessage(BOT, '哔哩哔哩客服的回复', 1)])))

  assert(current.activeCustomerService?.talker_info.name === '会员购店铺', 'the store chat should be open')
  assert(shownTexts().join('|') === '您的订单已发货', `only the store chat should show, got ${shownTexts()}`)
})

test('leaving 客服消息 before its chats load leaves the next conversation alone', async () => {
  await setup([customerService(1, 1, '您好'), friend])
  const gate = deferred<void>()
  customerServiceSessionsGate = gate.promise
  fetchCustomerServiceMessagesImpl = async () => csPage([csMessage(BOT, '客服的回复', 1)])

  await flush(() => current.selectSession(displayedCustomerService()))
  const directMessage = current.sessions.find(s => s.talker_id === FRIEND)
  if (!directMessage) throw new Error('the direct conversation should be listed')
  await flush(() => current.selectSession(directMessage))
  await flush(() => gate.resolve())

  assert(customerServiceCalls.fetchMessages.length === 0, 'a chat no longer wanted should not load')
  assert(!current.messagesLoading, 'the direct conversation should not be left loading')
  assert(current.selectedSession?.talker_id === FRIEND && current.messages.length === 1, 'its messages should stay')
})

test("switching account forgets the last account's customer service chats", async () => {
  await openCustomerServiceChat([csMessage(BOT, '您好，请问有什么可以帮您？', 1)])
  assert(current.activeCustomerService?.talker_info.name === '哔哩哔哩客服', 'a chat should be open first')

  await flush(() => current.switchAccount(FRIEND))

  assert(current.userInfo?.mid === FRIEND, 'the other account should be signed in')
  assert(current.activeCustomerService === null, 'no chat of the last account may stay open')
  assert(current.customerServiceSessions.length === 0, "the last account's chats should be forgotten")
})

test('customer service content reads as plain text, choices and notices', async () => {
  const parse = (msgType: number, content: unknown) =>
    parseCustomerServiceContent({ msg_type: msgType, content: JSON.stringify(content) })
  const text = (content: ReturnType<typeof parse>) => ('text' in content ? content.text : '')

  // pure_text is the whole answer; abs_text, an abstract that can be HTML, only stands in for it
  const full = parse(CS_MSG_TYPE.MACHINE_ANSWER, {
    type: 0,
    content: { pure_text: '完整回答', abs_text: '<p>摘要</p>' },
  })
  assert(text(full) === '完整回答', `pure_text should win, got ${text(full)}`)
  const markup = parse(CS_MSG_TYPE.MACHINE_ANSWER, {
    type: 0,
    content: { abs_text: '<p>第一行</p><p>第二&amp;行</p>' },
  })
  assert(text(markup) === '第一行\n第二&行', `markup should become text, got ${JSON.stringify(text(markup))}`)
  // Any entity reads as its character, and one that spells a tag stays text
  const entities = parse(CS_MSG_TYPE.MACHINE_ANSWER, {
    type: 0,
    content: { abs_text: '<p>请稍候&hellip;</p><p>&lt;b&gt;不是标签&lt;/b&gt;&nbsp;</p>' },
  })
  assert(text(entities) === '请稍候…\n<b>不是标签</b>', `entities should decode, got ${JSON.stringify(text(entities))}`)

  const unsafe = parse(CS_MSG_TYPE.MACHINE_ANSWER, {
    type: 0,
    content: { pure_text: '答', more_url: 'javascript:alert(1)' },
  })
  assert(unsafe.kind === 'text' && !unsafe.link, 'only web links may become links')

  const welcome = parse(CS_MSG_TYPE.MACHINE_WELCOME_QUESTIONS, {
    message: '猜你想问',
    problem_list: [{ intent: '如何申请退票？' }, { intent: '如何换票？' }],
  })
  assert(
    welcome.kind === 'choices' && welcome.choices.map(choice => choice.text).join('|') === '如何申请退票？|如何换票？',
    'should list choices'
  )

  const ended = parse(CS_MSG_TYPE.OUT_CUSTOMER_SESSION, {})
  assert(ended.kind === 'notice' && ended.text === '会话已结束', 'a closed session should be a notice')
  assert(parse(10999, {}).kind === 'notice', 'an unknown type should still show something')
  assert(
    getCustomerServicePreview({ msg_type: CS_MSG_TYPE.IMAGE, content: '{"url":"x"}' }) === '[图片]',
    'image preview'
  )
})

test("picking one of the bot's suggested questions asks it, as Bilibili's web client does", async () => {
  const offering = {
    ...csMessage(BOT, '', 1),
    msg_type: CS_MSG_TYPE.MACHINE_ANSWER,
    content: JSON.stringify({
      type: 2,
      relation: { message: '您可能还想了解:', problems: [{ problem_id: 2047, intent: '【会员购】催服务单处理' }] },
    }),
  }
  await openCustomerServiceChat([offering])

  const content = parseCustomerServiceContent(current.messages[0])
  if (content.kind !== 'choices') throw new Error(`the suggestions should be choices, got ${content.kind}`)
  await flush(async () => assert(await current.sendCustomerServiceReply(content.choices[0].reply), 'should send'))

  const [sent] = customerServiceCalls.sendMessage
  assert(sent?.msgType === CS_MSG_TYPE.MACHINE_QUESTION, `should send a question, got ${sent?.msgType}`)
  const question = JSON.parse(sent.content)
  assert(question.problem_id === 2047 && question.content === '【会员购】催服务单处理', 'should name the question')
  // Kept as the exact string: real keys exceed Number.MAX_SAFE_INTEGER
  assert(question.msg_key === offering.msg_key, `should cite the message that offered it, got ${question.msg_key}`)
  assert(directCalls.sendMessage === 0, 'must not go out as a direct message')
  assert(shownTexts().at(-1) === '【会员购】催服务单处理', `the question should show as sent, got ${shownTexts()}`)
})

test('businesses and the human agent can be picked once', async () => {
  const parse = (msgType: number, content: unknown) =>
    parseCustomerServiceContent({ msg_type: msgType, content: JSON.stringify(content), msg_key: '7000000000000000001' })

  const open = parse(CS_MSG_TYPE.SPLIT_ANSWER, {
    type: 0,
    message: '请选择要咨询的业务',
    business_list: [
      { business_id: 11, business_name: '会员购', select: 0 },
      { business_id: 12, business_name: '大会员', select: 0 },
    ],
  })
  if (open.kind !== 'choices') throw new Error('businesses should be choices')
  assert(open.once && !open.once.done, 'unpicked businesses should be open')
  const business = JSON.parse(open.choices[1].reply.content)
  assert(
    open.choices[1].reply.msgType === CS_MSG_TYPE.SPLIT_QUESTION &&
      business.type === 1 &&
      business.business_id === 12 &&
      business.content === '大会员' &&
      business.msg_key === '7000000000000000001',
    `picking a business should name it, got ${open.choices[1].reply.content}`
  )

  const picked = parse(CS_MSG_TYPE.SPLIT_ANSWER, {
    type: 1,
    group_list: [
      { group_id: 21, group_name: '账号', select: 1 },
      { group_id: 22, group_name: '支付', select: 0 },
    ],
  })
  if (picked.kind !== 'choices') throw new Error('groups should be choices')
  assert(picked.once?.done && picked.choices[0].picked && !picked.choices[1].picked, 'a picked group should lock')
  assert(JSON.parse(picked.choices[0].reply.content).group_id === 21, 'groups send their group_id')

  const manual = parse(CS_MSG_TYPE.MACHINE_ANSWER, { type: 4 })
  if (manual.kind !== 'choices') throw new Error('asking for a human agent should be a choice')
  const request = JSON.parse(manual.choices[0].reply.content)
  assert(
    manual.choices[0].text === '转接人工' && request.type === 0 && request.content === '转接人工',
    `should ask for a human agent, got ${manual.choices[0].reply.content}`
  )
  const manualDone = parse(CS_MSG_TYPE.MACHINE_ANSWER, { type: 4, selected: 1 })
  assert(manualDone.kind === 'choices' && manualDone.once?.done, 'a human agent asked for should lock')
})

test('a direct conversation that loads after 客服消息 opens leaves its chat alone', async () => {
  await setup([customerService(1, 1, '您好'), friend])
  const slow = deferred<BilibiliMessagesResponse>()
  fetchDirectMessagesImpl = () => slow.promise
  fetchCustomerServiceMessagesImpl = async () => csPage([csMessage(BOT, '客服的回复', 1)])

  await flush(() => current.selectSession(friend))
  await flush(() => current.selectSession(displayedCustomerService()))
  await flush(() => slow.resolve(directPage([message(FRIEND, '好友的私信', 1)])))

  assert(shownTexts().join('|') === '客服的回复', `only the customer service chat should show, got ${shownTexts()}`)
  assert(!current.messagesLoading, 'the customer service chat should have finished loading')
})

test('picking a chat while 客服消息 reopens keeps that chat', async () => {
  await setup([customerService(0, 1, '您好'), friend])
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服'), csSession(STORE_SHOP, '会员购店铺')]
  fetchCustomerServiceMessagesImpl = async ({ shopId }) =>
    csPage([csMessage(BOT, shopId === STORE_SHOP.shopId ? '会员购的回复' : '哔哩哔哩客服的回复', 1)])
  await flush(() => current.selectSession(displayedCustomerService()))
  await flush(() => current.selectSession(friend))

  // Back in 客服消息, the chat switcher is up while the list reloads
  const gate = deferred<void>()
  customerServiceSessionsGate = gate.promise
  await flush(() => current.selectSession(displayedCustomerService()))
  await flush(() => current.selectCustomerService(STORE_SHOP))
  await flush(() => gate.resolve())

  assert(current.activeCustomerService?.talker_info.name === '会员购店铺', 'the chat picked should stay open')
  assert(shownTexts().join('|') === '会员购的回复', `the picked chat should show, got ${shownTexts()}`)
})

test("a load still out for the last account stays out of the next one's chat", async () => {
  await setup([customerService(1, 1, '您好')])
  const slow = deferred<CustomerServiceMessagesResponse>()
  fetchCustomerServiceMessagesImpl = () => slow.promise
  await flush(() => current.selectSession(displayedCustomerService()))

  // The other account has a chat with Bilibili's own customer service too, the same shop 0/0
  fetchCustomerServiceMessagesImpl = async () => csPage([csMessage(BOT, '这个账号的客服回复', 1)])
  await flush(() => current.switchAccount(FRIEND))
  await flush(() => current.selectSession(displayedCustomerService()))
  await flush(() => slow.resolve(csPage([csMessage(BOT, '上个账号的客服回复', 1)])))

  assert(shownTexts().join('|') === '这个账号的客服回复', `only this account's chat should show, got ${shownTexts()}`)
  assert(customerServiceCalls.updateAck.length === 1, 'only this account should mark its chat read')
})

test("a direct conversation still loading for the last account stays out of the next one's", async () => {
  await setup([friend])
  const slow = deferred<BilibiliMessagesResponse>()
  fetchDirectMessagesImpl = () => slow.promise
  await flush(() => current.selectSession(friend))

  // The other account talks to the same contact
  fetchDirectMessagesImpl = async () => directPage([message(FRIEND, '这个账号的私信', 1)])
  await flush(() => current.switchAccount(OTHER_ACCOUNT))
  const same = current.sessions.find(s => s.talker_id === FRIEND)
  if (!same) throw new Error('the other account should list the contact too')
  await flush(() => current.selectSession(same))
  await flush(() => slow.resolve(directPage([message(FRIEND, '上个账号的私信', 1)])))

  assert(shownTexts().join('|') === '这个账号的私信', `only this account's messages should show, got ${shownTexts()}`)
})

test('a reply after a long gap pages back to the messages shown', async () => {
  const opening = [csMessage(BOT, '请问有什么可以帮您？', 1)]
  await openCustomerServiceChat(opening)
  // 22 replies came in while notifications were missed, more than the newest page holds
  const all = [...Array.from({ length: 22 }, (_, i) => csMessage(BOT, `回复 ${i + 2}`, i + 2)).reverse(), ...opening]
  fetchCustomerServiceMessagesImpl = async ({ endSeqno }) => {
    const start = endSeqno ? all.findIndex(m => m.seq_no === endSeqno) + 1 : 0
    return csPage(all.slice(start, start + 20), start + 20 < all.length)
  }
  await notify(customerServiceNotification, [customerService(1, 23, '回复 23')])

  const texts = shownTexts()
  assert(
    texts.length === 23 && texts[1] === '回复 2' && texts[22] === '回复 23',
    `nothing should be missing, got ${texts}`
  )
})

test('a page that fails keeps the messages that loaded', async () => {
  await setup([customerService(1, 1, '您好')])
  fetchCustomerServiceMessagesImpl = async ({ endSeqno }) =>
    endSeqno
      ? { error: 'Customer service messages were blocked by risk control', code: 412 }
      : csPage([csMessage(BOT, '最新的回复', 2), csMessage(USER, '我的问题', 1)], true)
  await flush(() => current.selectSession(displayedCustomerService()))

  assert(shownTexts().join('|') === '我的问题|最新的回复', `the newest page should still show, got ${shownTexts()}`)
  assert(!current.messagesLoading, 'the chat should not be left loading')
})

test('a reply and a message sent while the chat loads stay once it has loaded', async () => {
  await setup([customerService(1, 1, '您好')])
  const greeting = csMessage(BOT, '请问有什么可以帮您？', 1)
  const history = deferred<CustomerServiceMessagesResponse>()
  fetchCustomerServiceMessagesImpl = () => history.promise
  await flush(() => current.selectSession(displayedCustomerService()))

  // The bot replies while the chat's history is still loading, and the user answers it
  fetchCustomerServiceMessagesImpl = async () => csPage([csMessage(BOT, '已为您查询', 2), greeting])
  await notify(customerServiceNotification, [customerService(1, 2, '已为您查询')])
  await flush(async () => assert(await current.sendMessage('谢谢'), 'send should succeed'))
  await flush(() => history.resolve(csPage([greeting])))

  const texts = shownTexts().join('|')
  assert(
    texts === '请问有什么可以帮您？|已为您查询|谢谢',
    `nothing newer than the history should be lost, got ${texts}`
  )
})

test("a refresh for a chat that's gone from the list stays out of the one that opens instead", async () => {
  await setup([customerService(0, 1, '您好'), friend])
  customerServiceSessions = [csSession(STORE_SHOP, '会员购店铺')]
  fetchCustomerServiceMessagesImpl = async ({ shopId }) =>
    csPage([csMessage(BOT, shopId === STORE_SHOP.shopId ? '会员购的回复' : '哔哩哔哩客服的回复', 1)])
  await flush(() => current.selectSession(displayedCustomerService()))
  await flush(() => current.selectSession(friend))

  // Back in 客服消息, the store's chat is still the one picked while the list reloads, and has left it
  const gate = deferred<void>()
  customerServiceSessionsGate = gate.promise
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服')]
  await flush(() => current.selectSession(displayedCustomerService()))
  await notify(customerServiceNotification, [customerService(1, 2, '会员购的回复'), friend])
  await flush(() => gate.resolve())

  assert(current.activeCustomerService?.talker_info.name === '哔哩哔哩客服', 'the chat still listed should open')
  assert(shownTexts().join('|') === '哔哩哔哩客服的回复', `only its messages should show, got ${shownTexts()}`)
})

test("paging stops once the cursor doesn't move back", async () => {
  await setup([customerService(1, 1, '您好')])
  // An empty tail page that still says has_more, at seqno 0, which reads back as the newest page
  fetchCustomerServiceMessagesImpl = async ({ endSeqno }) =>
    endSeqno && endSeqno !== '0'
      ? { code: 0, message: '0', data: { messages: [], has_more: 1, min_seqno: '0', max_seqno: '0' } }
      : csPage([csMessage(BOT, '您好', 1)], true)
  await flush(() => current.selectSession(displayedCustomerService()))

  assert(
    customerServiceCalls.fetchMessages.length === 2,
    `paging should stop, asked ${customerServiceCalls.fetchMessages.length}`
  )
  assert(shownTexts().join('|') === '您好', `the chat should show once, got ${shownTexts()}`)
})

test("paging stops when a page's cursor stays put", async () => {
  await setup([customerService(1, 1, '您好')])
  const newer = csMessage(BOT, '较新', 2)
  const older = csMessage(BOT, '较旧', 1)
  // The second page holds messages but repeats the first page's cursor, which would page forever
  const repeat: CustomerServiceMessagesResponse = {
    code: 0,
    message: '0',
    data: { messages: [older], has_more: 1, min_seqno: newer.seq_no, max_seqno: older.seq_no },
  }
  fetchCustomerServiceMessagesImpl = async ({ endSeqno }) =>
    // Bounded, so a loop fails this test rather than hanging the run
    customerServiceCalls.fetchMessages.length > 4 ? csPage([]) : endSeqno ? repeat : csPage([newer], true)
  await flush(() => current.selectSession(displayedCustomerService()))

  assert(
    customerServiceCalls.fetchMessages.length === 2,
    `paging should stop, asked ${customerServiceCalls.fetchMessages.length}`
  )
  assert(shownTexts().join('|') === '较旧|较新', `the chat should show each page once, got ${shownTexts()}`)
})

test('客服消息 with no chat to show opens the one a reply brings', async () => {
  await setup([customerService(0, 1, '您好')])
  customerServiceSessions = []
  await flush(() => current.selectSession(displayedCustomerService()))
  assert(current.activeCustomerService === null, 'no chat should be open yet')
  await flush(async () => assert(!(await current.sendMessage('你好')), 'a send with no chat should fail'))
  assert(customerServiceCalls.sendMessage.length === 0, 'nothing should be sent without a chat')

  customerServiceSessions = [
    csSession(BILIBILI_SHOP, '哔哩哔哩客服', 1, csMessage(BOT, '您好，请问有什么可以帮您？', 1)),
  ]
  fetchCustomerServiceMessagesImpl = async () => csPage([csMessage(BOT, '您好，请问有什么可以帮您？', 1)])
  await notify(customerServiceNotification, [customerService(1, 2, '您好，请问有什么可以帮您？')])

  assert(current.activeCustomerService?.talker_info.name === '哔哩哔哩客服', 'the chat that appeared should open')
  assert(shownTexts().join('|') === '您好，请问有什么可以帮您？', `its messages should show, got ${shownTexts()}`)
})

test('a chat a reply opens with Comet in the background stays unread until the window is focused', async () => {
  await setup([customerService(0, 1, '您好')])
  customerServiceSessions = []
  await flush(() => current.selectSession(displayedCustomerService()))
  await flush(() => window.dispatchEvent(new Event('blur')))

  const reply = csMessage(BOT, '您好，请问有什么可以帮您？', 1)
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服', 1, reply)]
  fetchCustomerServiceMessagesImpl = async () => csPage([reply])
  await notify(customerServiceNotification, [customerService(1, 2, '您好，请问有什么可以帮您？')])
  assert(shownTexts().join('|') === '您好，请问有什么可以帮您？', `the chat should open, got ${shownTexts()}`)
  assert(customerServiceCalls.updateAck.length === 0, 'a reply nobody has looked at must stay unread')

  await flush(() => window.dispatchEvent(new Event('focus')))
  assert(customerServiceCalls.updateAck.length === 1, 'focusing the window should mark it read')
})

test('a send that returns after switching chats stays in its own chat', async () => {
  await setup([customerService(0, 1, '您好')])
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服'), csSession(STORE_SHOP, '会员购店铺')]
  fetchCustomerServiceMessagesImpl = async ({ shopId }) =>
    csPage([csMessage(BOT, shopId === STORE_SHOP.shopId ? '会员购的回复' : '哔哩哔哩客服的回复', 1)])
  const sending = deferred<CustomerServiceSendMessageResponse>()
  sendCustomerServiceMessageImpl = () => sending.promise
  await flush(() => current.selectSession(displayedCustomerService()))

  let sent: Promise<boolean> | undefined
  await flush(() => {
    sent = current.sendMessage('发给哔哩哔哩客服的消息')
  })
  await flush(() => current.selectCustomerService(STORE_SHOP))
  await flush(async () => {
    sending.resolve({ code: 0, message: '0', data: { msg_key: '900000000000000099' } })
    await sent
  })

  assert(customerServiceCalls.sendMessage[0]?.shopId === BILIBILI_SHOP.shopId, 'the message should go to its own chat')
  assert(shownTexts().join('|') === '会员购的回复', `the store chat should not show it, got ${shownTexts()}`)
})

test('an image still uploading when the account changes is not sent from the next one', async () => {
  await openCustomerServiceChat([csMessage(BOT, '请问有什么可以帮您？', 1)])
  const upload = deferred<UploadImageResult>()
  uploadImageImpl = () => upload.promise

  let sent: Promise<boolean> | undefined
  await flush(() => {
    sent = current.sendImageMessage('aW1hZ2U=', 'image/png')
  })
  await flush(() => current.switchAccount(OTHER_ACCOUNT))
  await flush(async () => {
    upload.resolve({ success: true, url: 'https://i0.hdslb.com/bfs/im/image.png', width: 1, height: 1 })
    assert(!(await sent), 'the image should not count as sent')
  })

  const [request] = customerServiceCalls.sendMessage
  assert(request?.senderMid === ME, `the send should name the account it was started from, got ${request?.senderMid}`)
  assert(!current.messages.some(m => m.msg_type === CS_MSG_TYPE.IMAGE), 'the next account should not show the image')
})

test("a refresh takes the server's copy of a choice already picked", async () => {
  const businesses = (select: number) =>
    JSON.stringify({ type: 0, business_list: [{ business_id: 11, business_name: '会员购', select }] })
  const offering = { ...csMessage(BOT, '', 1), msg_type: CS_MSG_TYPE.SPLIT_ANSWER, content: businesses(0) }
  await openCustomerServiceChat([offering])

  fetchCustomerServiceMessagesImpl = async () =>
    csPage([csMessage(BOT, '正在为您转接会员购客服', 2), { ...offering, content: businesses(1) }])
  await notify(customerServiceNotification, [customerService(1, 2, '正在为您转接会员购客服')])

  const content = parseCustomerServiceContent(current.messages[0])
  assert(content.kind === 'choices' && content.once?.done, 'the pick the server recorded should lock the choices')
  assert(current.messages.length === 2, `the reply should be added once, got ${current.messages.length}`)
})

test('a message that landed before one sent from here shows before it', async () => {
  const opening = [csMessage(BOT, '请问有什么可以帮您？', 1)]
  await openCustomerServiceChat(opening)
  await flush(async () => assert(await current.sendMessage('我的问题'), 'send should succeed'))

  // The agent's greeting was sent before the user's message, and only arrives now, with the reply
  const mine = { ...csMessage(USER, '我的问题', 3), msg_key: '900000000000000099' }
  fetchCustomerServiceMessagesImpl = async () =>
    csPage([csMessage(BOT, '回复', 4), mine, csMessage(BOT, '人工客服已接入', 2), ...opening])
  await notify(customerServiceNotification, [customerService(1, 4, '回复')])

  assert(
    shownTexts().join('|') === '请问有什么可以帮您？|人工客服已接入|我的问题|回复',
    `messages should keep the chat's order, got ${shownTexts()}`
  )
})

test("focusing the window doesn't mark read a chat that failed to load", async () => {
  await setup([customerService(1, 1, '您好')])
  fetchCustomerServiceMessagesImpl = async () => ({
    error: 'Customer service messages were blocked by risk control',
    code: 412,
  })
  await flush(() => current.selectSession(displayedCustomerService()))
  await flush(() => window.dispatchEvent(new Event('focus')))

  assert(customerServiceCalls.updateAck.length === 0, 'with nothing shown, nothing should be marked read')
})

test("reading one chat leaves another chat's new reply unread", async () => {
  await setup([customerService(0, 1, '您好')])
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服'), csSession(STORE_SHOP, '会员购店铺')]
  fetchCustomerServiceMessagesImpl = async () => csPage([csMessage(BOT, '哔哩哔哩客服的回复', 1)])
  await flush(() => current.selectSession(displayedCustomerService()))
  // The user is reading Bilibili's own chat when the store replies
  await flush(() => window.dispatchEvent(new Event('focus')))

  // 客服消息's refresh lands first, then the chat on screen, and the chat list last
  const chats = deferred<void>()
  customerServiceSessionsGate = chats.promise
  const page = deferred<CustomerServiceMessagesResponse>()
  fetchCustomerServiceMessagesImpl = () => page.promise
  customerServiceSessions = [
    csSession(STORE_SHOP, '会员购店铺', 1, csMessage(BOT, '您的订单已发货', 2)),
    csSession(BILIBILI_SHOP, '哔哩哔哩客服'),
  ]
  await notify({ talkerId: STORE_SHOP.shopId, sessionType: 4 }, [customerService(1, 2, '您的订单已发货')])
  await flush(() => page.resolve(csPage([csMessage(BOT, '哔哩哔哩客服的回复', 1)])))
  await flush(() => chats.resolve())

  const unread = displayedCustomerService().unread_count
  assert(unread === 1, `the store's reply should stay unread, got ${unread}`)
  assert(badge === 1, `the dock badge should count it, got ${badge}`)
})

test('a ticket shows its id as written', async () => {
  const ticket = parseCustomerServiceContent({
    msg_type: CS_MSG_TYPE.TICKET,
    content: '{"title":"留言通知","id":1781234567890123457,"create_name":"me"}',
  })
  const id = ticket.kind === 'card' ? ticket.details.find(detail => detail.label === '留言ID')?.value : undefined
  assert(id === '1781234567890123457', `the id should not be rounded, got ${id}`)
})

test('each customer service chat keeps a draft of its own', async () => {
  const folded = customerService(0, 1, '您好')
  const store = getDraftKey(ME, folded, STORE_SHOP)
  assert(store !== getDraftKey(ME, folded, BILIBILI_SHOP), 'two chats should not share a draft')
  assert(getSessionDraft({ [store]: '订单 123' }, getDraftKey(ME, folded)) === '订单 123', '客服消息 should list it')
  assert(getSessionDraft({ [store]: '订单 123' }, getDraftKey(ME, friend)) === undefined, 'others should not')
})

// A customer service message drawn on its own, as the message list draws it
async function renderBubble(message: CustomerServiceMessage, onReply: () => Promise<boolean>) {
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
  await flush(() =>
    root.render(
      <MessageBubble
        message={toDisplayMessage(message)}
        emojiInfoMap={{}}
        isSent={false}
        session={customerService(0, 1, '')}
        userCache={{}}
        userInfo={{ isLogin: true, mid: ME, uname: 'me' }}
        onCustomerServiceReply={onReply}
      />
    )
  )
  return container
}

const choiceButton = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === text)

test('a business picked once stays picked when its bubble is drawn again', async () => {
  const offering: CustomerServiceMessage = {
    ...csMessage(BOT, '', 1),
    msg_type: CS_MSG_TYPE.SPLIT_ANSWER,
    content: JSON.stringify({
      type: 0,
      message: '请选择要咨询的业务',
      business_list: [
        { business_id: 11, business_name: '会员购', select: 0 },
        { business_id: 12, business_name: '大会员', select: 0 },
      ],
    }),
  }
  let replies = 0
  const onReply = async () => {
    replies++
    return true
  }

  const first = await renderBubble(offering, onReply)
  await flush(() => choiceButton(first, '会员购')?.click())
  assert(replies === 1, `picking should reply once, replied ${replies}`)

  // The message list unmounts a bubble once it scrolls away, and draws a new one when it comes back
  await flush(() => root.unmount())
  const again = await renderBubble(offering, onReply)
  const business = choiceButton(again, '大会员')
  assert(business?.disabled, 'the businesses should stay locked once one is picked')
  await flush(() => business?.click())
  assert(replies === 1, `a second business must not be picked, replied ${replies}`)
})

test("choices from Bilibili's system sender stay buttons", async () => {
  const welcome: CustomerServiceMessage = {
    ...csMessage(participant(CS_SENDER_TYPE.SYS_NOTICE, 0, '系统通知'), '', 1),
    msg_type: CS_MSG_TYPE.MACHINE_WELCOME_QUESTIONS,
    content: JSON.stringify({ message: '猜你想问', problem_list: [{ problem_id: 1, intent: '如何申请退票？' }] }),
  }
  const container = await renderBubble(welcome, async () => true)
  const question = choiceButton(container, '如何申请退票？')
  assert(question && !question.disabled, 'the question should be a button to click, not text in a notice')
})

test("markup in a bot's answer shows as text, never as elements", async () => {
  const answer: CustomerServiceMessage = {
    ...csMessage(BOT, '', 1),
    msg_type: CS_MSG_TYPE.MACHINE_ANSWER,
    content: JSON.stringify({ type: 0, content: { abs_text: '<p>&lt;img src=x onerror=alert(1)&gt;</p>' } }),
  }
  const container = await renderBubble(answer, async () => true)
  assert(!container.querySelector('img[src="x"]'), 'the decoded tag must not become an element')
  assert(container.textContent?.includes('<img src=x onerror=alert(1)>'), 'it should read as the text it spells')
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
