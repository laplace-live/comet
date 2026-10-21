import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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
  FetchSessionsParams,
  FetchUsersParams,
  NewMessageNotification,
  SessionUpdateNotification,
  SetUnfollowFoldParams,
  ShowNotificationParams,
} from '@/types/electron'

import { SESSION_LIST_TYPE } from '@/types/bilibili'

import { type UsePrivateMessagesReturn, usePrivateMessages } from '@/hooks/usePrivateMessages'

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
// Another account of the user's, which leaves 收起未关注人消息 off
const OTHER_ACCOUNT = 789
const FOLLOWED = 201
// Chats with people the user doesn't follow, newest first
const STRANGER = 301
const FAN = 302
// Someone neither list has
const NEWCOMER = 303
// The other account's only chat, with someone it doesn't follow
const OTHER_STRANGER = 401

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
    receiver_id: ME,
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

/** A direct chat as get_sessions lists it, with its latest message at `ts` */
function chat(talkerId: number, follow: boolean, ts: number, unread = 0): BilibiliSession {
  return session({
    talker_id: talkerId,
    is_follow: follow ? 1 : 0,
    session_ts: ts * 1_000_000,
    unread_count: unread,
    max_seqno: ts,
    last_msg: message(talkerId, `来自 ${talkerId}`, ts),
  })
}

const chats = () => [chat(STRANGER, false, 50, 1), chat(FOLLOWED, true, 40, 2), chat(FAN, false, 30, 2)]
const isUnfollowed = (s: BilibiliSession) => s.session_type === 1 && s.is_follow === 0

let current: UsePrivateMessagesReturn
let root!: Root
// Bilibili's side, per account
let serverChats: Record<number, BilibiliSession[]>
let folding: Record<number, boolean>
// How many chats a page of 未关注人消息 holds
let unfollowedPageSize: number
// The next so many pages of 未关注人消息 fail
let failUnfollowedPages: number
// Holds back the next read of the setting, the next main list, and every save, until resolved
let linkSettingGate: Promise<unknown> | null
let mainListGate: Promise<unknown> | null
let saveGate: Promise<unknown>
let signedInMid: number
let sessionRequests: FetchSessionsParams[]
let saves: SetUnfollowFoldParams[]
let shown: ShowNotificationParams[]
let badge: number
let onNewMessage: (notification: NewMessageNotification) => void
let onSessionUpdate: (notification: SessionUpdateNotification) => void

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

const reply = { code: 0, msg: '0', message: '0', ttl: 1 }

function sessionsReply(list: BilibiliSession[], hasMore = false): BilibiliSessionsResponse {
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

const unreadOf = (list: BilibiliSession[]) => list.reduce((sum, s) => sum + s.unread_count, 0)

async function setup(folded: boolean) {
  serverChats = { [ME]: chats(), [OTHER_ACCOUNT]: [chat(OTHER_STRANGER, false, 70, 1)] }
  folding = { [ME]: folded, [OTHER_ACCOUNT]: false }
  unfollowedPageSize = 100
  failUnfollowedPages = 0
  linkSettingGate = null
  mainListGate = null
  saveGate = Promise.resolve()
  signedInMid = ME
  sessionRequests = []
  saves = []
  shown = []
  badge = -1
  window.electronAPI = {
    setBadgeCount: async (count: number) => {
      badge = count
      return { success: true }
    },
    bilibili: {
      getAccounts: async () => ({
        accounts: [
          { mid: ME, uname: 'me', isExpired: false },
          { mid: OTHER_ACCOUNT, uname: 'other', isExpired: false },
        ],
        activeAccountMid: signedInMid,
      }),
      checkLogin: async () => ({ isLogin: true, mid: signedInMid, uname: 'me' }),
      setActiveAccount: async ({ mid }: { mid: number }) => {
        signedInMid = mid
        return { success: true }
      },
      wsConnect: async () => ({ success: true }),
      wsDisconnect: async () => ({ success: true }),
      // Answered for the account signed in when asked, as the main process does
      fetchLinkSetting: async (): Promise<BilibiliLinkSettingResponse> => {
        const mid = signedInMid
        const gate = linkSettingGate
        linkSettingGate = null
        await gate
        return { ...reply, data: { show_unfollowed_msg: folding[mid] ? 1 : 0 } }
      },
      setUnfollowFold: async (params: SetUnfollowFoldParams) => {
        const mid = signedInMid
        saves.push(params)
        await saveGate
        folding[mid] = params.enabled
        return { success: true }
      },
      fetchSessions: async (params: FetchSessionsParams) => {
        sessionRequests.push(params)
        const list = serverChats[signedInMid]
        if (params.sessionType === String(SESSION_LIST_TYPE.UNFOLLOWED)) {
          if (failUnfollowedPages > 0) {
            failUnfollowedPages--
            return { error: 'Failed to fetch sessions from Bilibili', code: 500 }
          }
          const endTs = params.endTs === undefined ? Infinity : Number(params.endTs)
          const older = list.filter(s => isUnfollowed(s) && s.session_ts < endTs)
          return sessionsReply(older.slice(0, unfollowedPageSize), older.length > unfollowedPageSize)
        }
        const gate = mainListGate
        mainListGate = null
        await gate
        return sessionsReply(params.unfollowFold ? list.filter(s => !isUnfollowed(s)) : list)
      },
      fetchSingleUnread: async (): Promise<BilibiliSingleUnreadResponse> => {
        const list = serverChats[signedInMid]
        return {
          ...reply,
          data: {
            unfollow_unread: unreadOf(list.filter(isUnfollowed)),
            follow_unread: unreadOf(list.filter(s => !isUnfollowed(s))),
            unfollow_push_msg: 0,
            dustbin_push_msg: 0,
            dustbin_unread: 0,
            biz_msg_unfollow_unread: 0,
            biz_msg_follow_unread: 0,
            custom_unread: 0,
          },
        }
      },
      fetchMessages: async (): Promise<BilibiliMessagesResponse> => ({
        ...reply,
        data: { messages: [message(FAN, '你好', 1)], has_more: 0, min_seqno: 1, max_seqno: 1 },
      }),
      updateAck: async () => ({ code: 0 }),
      fetchUsers: async ({ uids }: FetchUsersParams): Promise<BilibiliUserCardsResponse> => ({
        ...reply,
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
      showNotification: async (params: ShowNotificationParams) => {
        shown.push(params)
        return { shown: true }
      },
      onNewMessage: (callback: (notification: NewMessageNotification) => void) => {
        onNewMessage = callback
        return () => undefined
      },
      onSessionUpdate: (callback: (notification: SessionUpdateNotification) => void) => {
        onSessionUpdate = callback
        return () => undefined
      },
      onWsConnected: () => () => undefined,
      onWsDisconnected: () => () => undefined,
      onNavigateToSession: () => () => undefined,
    },
  } as unknown as typeof window.electronAPI
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
  await flush(() => root.render(<Harness />))
  await flush(() => window.dispatchEvent(new Event('focus')))
  assert(current.userInfo?.mid === ME, 'the harness should log in')
  await flush(() => current.fetchSessions())
}

const ids = (list: BilibiliSession[] | undefined) => (list ?? []).map(s => s.talker_id).join(',')
const listed = () => ids(current.sessions)
const folded = () => ids(current.unfollowed?.sessions)
const unfollowedPagesSince = (count: number) =>
  sessionRequests.slice(count).filter(p => p.sessionType === String(SESSION_LIST_TYPE.UNFOLLOWED)).length

async function notifyFrom(talkerId: number, text: string) {
  await flush(() =>
    onNewMessage({
      talkerId,
      sessionType: 1,
      instantMsg: {
        senderUid: talkerId,
        receiverType: 1,
        receiverId: ME,
        msgType: 1,
        content: JSON.stringify({ content: text }),
        msgSeqno: 99,
        timestamp: 99,
        msgKey: '99',
      },
    })
  )
}

function foldedChat(talkerId: number): BilibiliSession {
  const found = current.unfollowed?.sessions.find(s => s.talker_id === talkerId)
  if (!found) throw new Error(`${talkerId} should be in 未关注人消息`)
  return found
}

const tests: Array<{ name: string; run: () => Promise<void> }> = []
function test(name: string, run: () => Promise<void>) {
  tests.push({ name, run })
}

test("with 收起未关注人消息 on, chats with people the user doesn't follow fold into 未关注人消息", async () => {
  await setup(true)
  assert(current.unfollowFold === true, 'the setting should be read from Bilibili')
  assert(listed() === `${FOLLOWED}`, `the main list should keep the followed chat only, got ${listed()}`)
  assert(folded() === `${STRANGER},${FAN}`, `未关注人消息 should list the rest, newest first, got ${folded()}`)
  assert(current.unfollowed?.unread === 3, `its unread should be Bilibili's count, got ${current.unfollowed?.unread}`)
  assert(badge === 2, `the dock badge should leave folded chats out, got ${badge}`)
})

test('with it off, every chat stays in the main list and 未关注人消息 is never fetched', async () => {
  await setup(false)
  assert(current.unfollowFold === false, 'the setting should be read as off')
  assert(listed() === `${STRANGER},${FOLLOWED},${FAN}`, `every chat should be listed, got ${listed()}`)
  assert(current.unfollowed === null, 'there should be no 未关注人消息')
  assert(unfollowedPagesSince(0) === 0, 'nothing should ask for 未关注人')
  assert(badge === 5, `the dock badge should count every chat, got ${badge}`)
})

test('turning it on saves it to Bilibili and folds the lists', async () => {
  await setup(false)
  await flush(() => current.toggleUnfollowFold(true))
  assert(saves.length === 1 && saves[0].enabled, 'the switch should save the setting')
  assert(folding[ME], 'Bilibili should have it on')
  assert(listed() === `${FOLLOWED}` && folded() === `${STRANGER},${FAN}`, `got ${listed()} / ${folded()}`)
})

test('a page of 未关注人消息 that fails to load leaves both lists as they were', async () => {
  await setup(false)
  failUnfollowedPages = 1
  await flush(() => current.toggleUnfollowFold(true))
  assert(folding[ME], 'the setting still saves')
  assert(listed() === `${STRANGER},${FOLLOWED},${FAN}`, `no chat may go missing, got ${listed()}`)
  assert(
    current.unfollowFold === false && current.unfollowed === null,
    'the fold applies with its lists, or not at all'
  )
})

test('a refresh still out when the fold turns on lands nothing, so no chat shows in both lists', async () => {
  await setup(false)
  const refresh = deferred<void>()
  mainListGate = refresh.promise
  // A quiet refresh asks for the unfolded main list, and is still out when the fold turns on
  await flush(() => onSessionUpdate({ type: 'session_list' }))
  await flush(() => current.toggleUnfollowFold(true))
  assert(listed() === `${FOLLOWED}`, `the fold should apply, got ${listed()}`)
  await flush(() => refresh.resolve())
  assert(listed() === `${FOLLOWED}`, `the unfolded refresh must not land, got ${listed()}`)
  assert(folded() === `${STRANGER},${FAN}`, `未关注人消息 should keep its chats, got ${folded()}`)
})

test('turning it off unfolds every chat and closes 未关注的人', async () => {
  await setup(true)
  await flush(() => current.openUnfollowed())
  assert(current.unfollowed?.open, '未关注的人 should open')
  await flush(() => current.toggleUnfollowFold(false))
  assert(listed() === `${STRANGER},${FOLLOWED},${FAN}`, `every chat should be back, got ${listed()}`)
  assert(current.unfollowed === null, '未关注人消息 should be gone')
  await flush(() => current.toggleUnfollowFold(true))
  assert(current.unfollowed && !current.unfollowed.open, 'turning it on again should not reopen 未关注的人')
})

test('a save that a reload overtakes still applies once it lands', async () => {
  await setup(false)
  const save = deferred<void>()
  saveGate = save.promise
  let toggled!: Promise<boolean>
  await flush(() => {
    toggled = current.toggleUnfollowFold(true)
  })
  // A reload while it saves reads the setting as it was
  await flush(() => current.fetchSessions())
  assert(listed() === `${STRANGER},${FOLLOWED},${FAN}`, `the reload should read the old setting, got ${listed()}`)
  await flush(async () => {
    save.resolve()
    await toggled
  })
  assert(listed() === `${FOLLOWED}` && folded() === `${STRANGER},${FAN}`, `got ${listed()} / ${folded()}`)
})

test('a load the last account started lands nothing once another account signs in', async () => {
  await setup(true)
  const read = deferred<void>()
  linkSettingGate = read.promise
  let reload!: Promise<void>
  await flush(() => {
    reload = current.fetchSessions()
  })
  await flush(() => current.switchAccount(OTHER_ACCOUNT))
  await flush(async () => {
    read.resolve()
    await reload
  })
  assert(current.unfollowFold === false, 'the other account folds nothing')
  assert(listed() === `${OTHER_STRANGER}`, `the other account's chats should show, got ${listed()}`)
  assert(current.unfollowed === null, "the last account's 未关注人消息 should not come back")
})

test('a message in a folded chat stays quiet, while followed chats and the open folded chat notify', async () => {
  await setup(true)
  await flush(() => window.dispatchEvent(new Event('blur')))
  await notifyFrom(STRANGER, '在吗')
  assert(shown.length === 0, `a folded chat should not notify, got ${shown.length}`)
  await notifyFrom(FOLLOWED, '晚上好')
  assert(shown.length === 1 && shown[0].talkerId === FOLLOWED, 'a followed chat should notify')
  await flush(() => current.selectSession(foldedChat(FAN)))
  await flush(() => window.dispatchEvent(new Event('blur')))
  await notifyFrom(FAN, '收到了吗')
  assert(shown.length === 2 && shown[1].talkerId === FAN, 'the folded chat open now should notify')
})

test('a chat neither list has yet still notifies, rather than risk swallowing a message', async () => {
  await setup(true)
  await flush(() => window.dispatchEvent(new Event('blur')))
  await notifyFrom(NEWCOMER, '你好')
  assert(shown.length === 1 && shown[0].talkerId === NEWCOMER, 'an unresolved chat should notify')
})

test('reading a folded chat takes its unread off 未关注人消息', async () => {
  await setup(true)
  await flush(() => current.selectSession(foldedChat(FAN)))
  assert(foldedChat(FAN).unread_count === 0, 'the chat should read as read')
  assert(current.unfollowed?.unread === 1, `its 2 unread should come off the 3, got ${current.unfollowed?.unread}`)
})

test('reading folded chats elsewhere refreshes them and their count together', async () => {
  await setup(true)
  serverChats[ME] = serverChats[ME].map(s => (s.talker_id === FAN ? { ...s, unread_count: 0 } : s))
  await flush(() => onSessionUpdate({ type: 'total_unread' }))
  assert(current.unfollowed?.unread === 1, `the count should follow, got ${current.unfollowed?.unread}`)
  assert(foldedChat(FAN).unread_count === 0, "the chat's own unread should follow too")
})

test('a change elsewhere to a chat outside the main list refreshes 未关注人消息', async () => {
  await setup(true)
  let before = sessionRequests.length
  await flush(() => onSessionUpdate({ type: 'session_list', sessionId: { privateId: { uid: FAN } } }))
  assert(unfollowedPagesSince(before) === 1, "a folded chat's change should refresh 未关注人消息")
  before = sessionRequests.length
  await flush(() => onSessionUpdate({ type: 'session_list', sessionId: { privateId: { uid: FOLLOWED } } }))
  assert(unfollowedPagesSince(before) === 0, "a followed chat's change should leave it alone")
  before = sessionRequests.length
  await flush(() => onSessionUpdate({ type: 'session_list', sessionId: { privateId: { uid: NEWCOMER } } }))
  assert(unfollowedPagesSince(before) === 1, 'a chat no list has loaded may be a folded one past the loaded pages')
})

test('asking for the next page of 未关注人消息 twice at once loads it once', async () => {
  await setup(true)
  unfollowedPageSize = 1
  await flush(() => current.fetchSessions())
  assert(
    folded() === `${STRANGER}` && current.unfollowed?.hasMore,
    `the first page should hold one chat, got ${folded()}`
  )
  const before = sessionRequests.length
  await flush(() => Promise.all([current.loadMoreUnfollowed(), current.loadMoreUnfollowed()]))
  assert(
    unfollowedPagesSince(before) === 1,
    `the next page should be asked for once, got ${unfollowedPagesSince(before)}`
  )
  assert(folded() === `${STRANGER},${FAN}`, `the next page should land once, got ${folded()}`)
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
