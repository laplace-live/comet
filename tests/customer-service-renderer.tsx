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
  CustomerServiceSession,
} from '@/types/bilibili'
import type {
  CustomerServiceShop,
  FetchCustomerServiceMessagesParams,
  FetchUsersParams,
  NewMessageNotification,
  SendCustomerServiceMessageParams,
  ShowNotificationParams,
} from '@/types/electron'

import { CS_MSG_TYPE, CS_SENDER_TYPE, SYSTEM_MSG_TYPE } from '@/types/bilibili'

import { getCustomerServicePreview, parseCustomerServiceContent } from '@/lib/customer-service'

import { type UsePrivateMessagesReturn, usePrivateMessages } from '@/hooks/usePrivateMessages'

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

function csSession(shop: CustomerServiceShop, name: string, unread = 0): CustomerServiceSession {
  return {
    talker_info: {
      ...participant(CS_SENDER_TYPE.CUSTOMER, 0, name),
      shop_father_id: shop.shopFatherId,
      shop_id: shop.shopId,
    },
    last_msg: null,
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
) => Promise<CustomerServiceMessagesResponse>
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

async function setup(initialSessions: BilibiliSession[]) {
  serverSessions = initialSessions
  fetchSessionsImpl = async () => sessionsResponse()
  shown = []
  setDndCalls = 0
  badge = -1
  customerServiceSessions = [csSession(BILIBILI_SHOP, '哔哩哔哩客服')]
  customerServiceSessionsGate = Promise.resolve()
  fetchCustomerServiceMessagesImpl = async () => csPage([])
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
      // A lookup of the notified chat finds someone else's message, which a sender check would trust
      fetchMessages: async (): Promise<BilibiliMessagesResponse> => {
        directCalls.fetchMessages++
        return {
          code: 0,
          msg: '0',
          message: '0',
          ttl: 1,
          data: { messages: [message(0, '您好，请问有什么可以帮您？', 1)], has_more: 0, min_seqno: 1, max_seqno: 1 },
        }
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
          return { code: 0, message: '0', data: { msg_key: '900000000000000099' } }
        },
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
      onNavigateToSession: () => () => undefined,
    },
  } as unknown as typeof window.electronAPI
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
  await flush(() => root.render(<Harness />))
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
  // Neither a message lookup nor an instant message that names someone else may count as a reply
  await notify(customerServiceNotification, [customerService(0, 2, '我想咨询一下')])
  await notify({ ...customerServiceNotification, instantMsg: instantMsg(0, '我想咨询一下') }, [
    customerService(0, 3, '我想咨询一下'),
  ])
  assert(shown.length === 0, `a message that adds no unread must not notify, got ${shown.length}`)
  assert(displayedCustomerService().session_ts === 3, 'the notifications should still refresh 客服消息')
})

test('a customer service reply notifies once as 客服消息', async () => {
  await setup([customerService(0, 1, '我想咨询一下')])
  await notify(customerServiceNotification, [customerService(1, 2, '已为您转接人工客服')])
  assert(shown.length === 1, 'a reply that raises the unread count should notify')
  const [notification] = shown
  assert(notification.title === '客服消息', `title should name 客服消息, got ${notification.title}`)
  assert(notification.body === '已为您转接人工客服', `body should be the reply, got ${notification.body}`)
  assert(notification.icon === 'https://i0.hdslb.com/bfs/face/customer-service.png', 'icon should be its avatar')
  assert(notification.talkerId === 0 && notification.sessionType === 1, 'a click should open 客服消息')
})

test('overlapping notifications for one reply notify once', async () => {
  await setup([customerService(0, 1, '我想咨询一下')])
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

test('muting 客服消息 stays local and silences it', async () => {
  await setup([customerService(2, 1, '已为您转接人工客服'), friend])
  await flush(async () => assert(await current.toggleDnd(displayedCustomerService(), true), 'muting should succeed'))
  assert(setDndCalls === 0, 'set_msg_dnd cannot target 客服消息 and must not be called')
  assert(useSettings.getState().customerServiceMutedMids.includes(ME), 'the mute should be kept for this account')
  assert(badge === 0, `muted unread must leave the badge, got ${badge}`)

  await notify(customerServiceNotification, [customerService(3, 2, '请问还有其他问题吗？'), friend])
  assert(shown.length === 0, 'a muted reply must not notify')
  assert(displayedCustomerService().is_dnd === 1, 'the mute should survive a refresh')

  await flush(async () => assert(await current.toggleDnd(displayedCustomerService(), false), 'unmuting should succeed'))
  assert(displayedCustomerService().is_dnd === 0 && badge === 3, 'unmuting should restore the session')
  await notify(customerServiceNotification, [customerService(4, 3, '感谢您的耐心等待'), friend])
  assert(shown.length === 1, 'an unmuted reply should notify again')
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
