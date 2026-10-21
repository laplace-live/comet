// The Bilibili a run talks to: three accounts, one creator's inbox and its conversations, answered
// from the main process's own requests. Every reply is typed with the app's API types, so a renamed
// field fails `pnpm typecheck` instead of drifting a picture. Everyone in it is made up.

import { createHash } from 'node:crypto'

import type {
  BilibiliLinkSettingResponse,
  BilibiliMessage,
  BilibiliMessagesResponse,
  BilibiliNavResponse,
  BilibiliQRCodeGenerateResponse,
  BilibiliQRCodePollResponse,
  BilibiliSession,
  BilibiliSessionsResponse,
  BilibiliSingleUnreadResponse,
  BilibiliUserCard,
  BilibiliUserCardsResponse,
  FanGroupSystemContent,
  ImageMessageContent,
  TextMessageContent,
} from '@/types/bilibili'
import type { UpdateAckResponse } from '@/types/electron'

import { MSG_SOURCE, MSG_TYPE, QR_CODE_STATUS, SESSION_LIST_TYPE, SESSION_TYPE } from '@/types/bilibili'

import { BILIBILI_API, BILIBILI_ENDPOINTS } from '@/lib/const'

import { type Face, fanArt } from './art.ts'

/** The instant every run happens at, Sunday 4 October 2026, 20:32 in Beijing; the renderer's clock is held here. */
export const SHOWCASE_NOW = Date.UTC(2026, 9, 4, 12, 32)
export const SHOWCASE_TIME_ZONE = 'Asia/Shanghai'

/** `.invalid` never resolves, so a picture the showcase can't answer can't leave the machine either. */
const PICTURE_ORIGIN = 'https://showcase.invalid'

// The pictures print UIDs, so every mid lies between 2^32 and 10^10, a range Bilibili hands none out from: its
// 10-digit UIDs fit in 32 bits, and its newer ones have 16 digits.

/** Who signs in, in the order the account menu lists them. `alt` is signed out on Bilibili's side mid-run. */
export const ACCOUNTS = {
  station: { mid: 6283185307, uname: '纯良奶糖花', face: ['🌸', '#4f46e5', '#9333ea'] },
  clips: { mid: 4669201609, uname: '纯良花私联专用', face: ['🤫', '#06b6d4', '#2563eb'] },
  alt: { mid: 8314462618, uname: '纯良奶糖花小号', face: ['🌙', '#94a3b8', '#334155'] },
} satisfies Record<string, { mid: number; uname: string; face: Face }>

type AccountKey = keyof typeof ACCOUNTS

interface Person {
  mid: number
  name: string
  face: Face
  /** 0 personal, 1 organisation. */
  official?: { type: number; title: string }
  /** 大会员's nickname colour. */
  vip?: string
}

const PEOPLE = {
  yuzu: { mid: 2132180406, name: '明前奶绿', face: ['🍵', '#fde68a', '#fb923c'] },
  boat: {
    mid: 6931471805,
    name: '夜航船',
    face: ['⛵', '#1e3a8a', '#38bdf8'],
    official: { type: 0, title: '音乐区 UP 主' },
  },
  momo: { mid: 5772156649, name: 'Momo', face: ['🍑', '#fce7f3', '#f472b6'], vip: '#FB7299' },
  studio: {
    mid: 6022140760,
    name: '星海音乐工作室',
    face: ['🎵', '#38bdf8', '#6366f1'],
    official: { type: 1, title: '星海音乐工作室官方账号' },
  },
  matcha: { mid: 9869604401, name: '抹茶拿铁', face: ['🍵', '#d9f99d', '#16a34a'] },
  sleepy: { mid: 6626070150, name: '上海小伙爱私联', face: ['😴', '#ede9fe', '#a78bfa'] },
  cat: { mid: 5670374419, name: '路过的猫', face: ['🐱', '#f5f5f4', '#a8a29e'] },
  qing: { mid: 9648533212, name: '阿青', face: ['🌿', '#ccfbf1', '#0d9488'] },
} satisfies Record<string, Person>

type PersonKey = keyof typeof PEOPLE

const FAN_GROUP = { id: 31415926, name: '星屑电台粉丝团', face: ['💫', '#a855f7', '#ec4899'] satisfies Face }

const FAN_ART = { path: '/album/fan-art.png', ...fanArt() }

export type ConversationKey = PersonKey | 'fans'

interface Line {
  /** Minutes before {@link SHOWCASE_NOW}. */
  at: number
  from: 'me' | PersonKey
  text?: string
  image?: true
  /** A fan group notice, drawn centred. */
  notice?: string
  /** `MSG_SOURCE`; the sender's phone for others, Web for the station. */
  source?: number
}

interface Conversation {
  key: ConversationKey
  pinned?: boolean
  follow?: boolean
  dnd?: boolean
  unread: number
  /** Oldest first. */
  lines: Line[]
}

const DAY = 24 * 60

/** The station's inbox, in the order Bilibili lists it: pinned first, then the latest. */
const INBOX: Conversation[] = [
  {
    key: 'boat',
    pinned: true,
    follow: true,
    unread: 1,
    lines: [
      { at: 3 * DAY + 40, from: 'boat', text: '下个月的联动企划有兴趣吗？' },
      { at: 3 * DAY + 10, from: 'me', text: '有的有的！发来看看～' },
      { at: 26, from: 'boat', text: '企划书整理好了，发你邮箱啦，有空看看～' },
    ],
  },
  {
    key: 'yuzu',
    unread: 1,
    lines: [
      {
        at: DAY + 120,
        from: 'me',
        text: '感谢关注星屑电台！每周日晚九点歌回，不见不散 ✨',
        source: MSG_SOURCE.AUTO_REPLY_FOLLOW,
      },
      { at: DAY + 117, from: 'yuzu', text: '主播晚上好！第一次听歌回就被圈粉了' },
      { at: 22, from: 'yuzu', text: '电台一周年快乐！🎉 偷偷准备了一份礼物' },
      { at: 21, from: 'yuzu', text: '熬夜画了一张图，送给你' },
      { at: 20, from: 'yuzu', image: true },
      { at: 3, from: 'yuzu', text: '自拍' },
      { at: 1, from: 'me', text: '没法说你！' },
    ],
  },
  {
    key: 'fans',
    dnd: true,
    unread: 37,
    lines: [
      { at: 25, from: 'boat', text: '今晚几点开播呀？', source: MSG_SOURCE.WEB },
      { at: 24, from: 'me', text: '九点准时开播，今天首唱新歌 🎤' },
      { at: 20, from: 'matcha', text: '好耶！！', source: MSG_SOURCE.ANDROID },
      { at: 12, from: 'me', notice: '欢迎 路过的猫 加入粉丝团' },
      { at: 11, from: 'cat', text: '新人报到！已经在直播间门口蹲着了' },
      { at: 9, from: 'me', text: '欢迎欢迎～今晚见！' },
      { at: 6, from: 'yuzu', text: '一周年快乐！今晚一定准时到 🎉' },
      { at: 4, from: 'momo', text: '九点准时蹲！', source: MSG_SOURCE.ANDROID },
    ],
  },
  {
    key: 'momo',
    unread: 2,
    lines: [
      { at: 40, from: 'momo', text: '上次直播的切片做好了，你看看效果', source: MSG_SOURCE.ANDROID },
      { at: 38, from: 'momo', image: true, source: MSG_SOURCE.ANDROID },
    ],
  },
  {
    key: 'studio',
    unread: 1,
    lines: [
      {
        at: 185,
        from: 'studio',
        text: '您好，我们是星海音乐工作室。年末想邀请您参与一首合作曲的演唱，方便的话可以详细聊聊吗？',
        source: MSG_SOURCE.WEB,
      },
    ],
  },
  {
    key: 'matcha',
    unread: 0,
    lines: [
      { at: DAY + 40, from: 'matcha', text: '今天的歌回也辛苦啦！', source: MSG_SOURCE.ANDROID },
      { at: DAY + 35, from: 'me', text: '谢谢！晚安，明天见～' },
    ],
  },
  {
    key: 'sleepy',
    dnd: true,
    unread: 0,
    lines: [{ at: 2 * DAY + 50, from: 'sleepy', text: '又熬夜了吧！快去睡觉 😤' }],
  },
  {
    key: 'cat',
    unread: 0,
    lines: [{ at: 5 * DAY, from: 'cat', text: '路过，留下一只猫 🐾' }],
  },
  {
    key: 'qing',
    unread: 0,
    lines: [{ at: 16 * DAY, from: 'qing', text: '谢谢你的回复！会一直支持你的' }],
  },
]

const facePath = (key: string): string => `/face/${key}.png`
const faceUrl = (key: string): string => `${PICTURE_ORIGIN}${facePath(key)}`

/** Every face an avatar may show, by key: the accounts', the people's and the fan group's. */
const FACES: Record<string, Face> = {
  ...Object.fromEntries(Object.entries(ACCOUNTS).map(([key, a]) => [key, a.face])),
  ...Object.fromEntries(Object.entries(PEOPLE).map(([key, p]) => [key, p.face])),
  fans: FAN_GROUP.face,
}

/** Bilibili's timestamps are seconds; session times are microseconds. */
const seconds = (minutesAgo: number): number => Math.floor((SHOWCASE_NOW - minutesAgo * 60_000) / 1000)

/** A chat with someone the station doesn't follow, which 收起未关注人消息 folds into 未关注人消息. */
const unfollowed = (conversation: Conversation): boolean => conversation.key !== 'fans' && !conversation.follow

const unreadOf = (conversations: Conversation[]): number => conversations.reduce((sum, c) => sum + c.unread, 0)

/** The talker id and session type Bilibili files a conversation under. */
function talker(key: ConversationKey): { id: number; type: number } {
  return key === 'fans'
    ? { id: FAN_GROUP.id, type: SESSION_TYPE.FAN_GROUP }
    : { id: PEOPLE[key].mid, type: SESSION_TYPE.USER }
}

function messages(conversation: Conversation, accountMid: number): BilibiliMessage[] {
  const { id, type } = talker(conversation.key)
  return conversation.lines.map((line, index): BilibiliMessage => {
    const sender = line.notice !== undefined ? 0 : line.from === 'me' ? accountMid : PEOPLE[line.from].mid
    const content =
      line.notice !== undefined
        ? ({ group_id: FAN_GROUP.id, content: line.notice } satisfies FanGroupSystemContent)
        : line.image
          ? ({
              url: `${PICTURE_ORIGIN}${FAN_ART.path}`,
              width: FAN_ART.width,
              height: FAN_ART.height,
              imageType: 'png',
              original: 1,
              // In KB, as Bilibili counts it.
              size: Math.round(FAN_ART.png.length / 1024),
            } satisfies ImageMessageContent)
          : ({ content: line.text ?? '' } satisfies TextMessageContent)
    return {
      sender_uid: sender,
      receiver_type: type,
      receiver_id: type === SESSION_TYPE.FAN_GROUP || sender === accountMid ? id : accountMid,
      msg_type: line.notice !== undefined ? MSG_TYPE.FAN_GROUP_SYSTEM : line.image ? MSG_TYPE.IMAGE : MSG_TYPE.TEXT,
      content: JSON.stringify(content),
      msg_seqno: index + 1,
      timestamp: seconds(line.at),
      at_uids: null,
      // Past 2^53 like the real keys, which the main process keeps as strings.
      msg_key: String(7_563_000_000_000_000_000n + BigInt(id) * 1000n + BigInt(index)),
      msg_status: 0,
      notify_code: '',
      new_face_version: 0,
      msg_source:
        line.notice !== undefined
          ? MSG_SOURCE.FAN_GROUP_SYSTEM
          : (line.source ?? (line.from === 'me' ? MSG_SOURCE.WEB : MSG_SOURCE.IOS)),
    }
  })
}

function session(conversation: Conversation, accountMid: number): BilibiliSession {
  const { id, type } = talker(conversation.key)
  const all = messages(conversation, accountMid)
  const last = all[all.length - 1]
  const fans = conversation.key === 'fans'
  return {
    talker_id: id,
    session_type: type,
    at_seqno: 0,
    top_ts: conversation.pinned ? seconds(30 * DAY) * 1_000_000 : 0,
    group_name: fans ? FAN_GROUP.name : '',
    group_cover: fans ? faceUrl('fans') : '',
    is_follow: conversation.follow ? 1 : 0,
    is_dnd: conversation.dnd ? 1 : 0,
    ack_seqno: last.msg_seqno - conversation.unread,
    ack_ts: last.timestamp * 1_000_000,
    session_ts: last.timestamp * 1_000_000,
    unread_count: conversation.unread,
    last_msg: last,
    group_type: 0,
    can_fold: 0,
    status: 0,
    max_seqno: last.msg_seqno,
    new_push_msg: 0,
    setting: 0,
    is_guardian: 0,
    is_intercept: 0,
    is_trust: 0,
    system_msg_type: 0,
    live_status: 0,
    biz_msg_unread_count: 0,
    user_label: null,
  }
}

function card(key: string, person: Person): BilibiliUserCard {
  return {
    mid: person.mid,
    name: person.name,
    face: faceUrl(key),
    sign: '',
    rank: 10000,
    level: 5,
    silence: 0,
    vip: person.vip
      ? { type: 2, status: 1, due_date: SHOWCASE_NOW + 300 * DAY * 60_000, nickname_color: person.vip }
      : { type: 0, status: 0, due_date: 0, nickname_color: '' },
    official: person.official
      ? { role: person.official.type === 1 ? 3 : 1, title: person.official.title, desc: '', type: person.official.type }
      : { role: 0, title: '', desc: '', type: -1 },
  }
}

/** One QR code for every login: what the phone confirms decides who signs in. */
const QR_KEY = createHash('md5').update('laplace-comet-screenshots').digest('hex')
const QR_URL = `https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=${QR_KEY}&from=`

/** The legacy login URL, credentials in its query, which the app reads without a ticket exchange. */
function loginUrl(key: AccountKey): string {
  const { mid } = ACCOUNTS[key]
  const url = new URL(`${BILIBILI_API.PASSPORT_GAME}/x/passport-login/web/crossDomain`)
  url.searchParams.set('DedeUserID', String(mid))
  url.searchParams.set('DedeUserID__ckMd5', createHash('md5').update(String(mid)).digest('hex').slice(0, 16))
  url.searchParams.set('SESSDATA', `showcase-${key}`)
  url.searchParams.set('bili_jct', 'showcase')
  return url.toString()
}

interface Showcase {
  /** Stands in for the main process's `fetch`. */
  fetch: typeof fetch
  /** Answers the renderer's picture requests. */
  serve: (request: Request) => Response
  /** The faces avatars show, by key, for `paintFaces` to paint before any is asked for. */
  faces: Record<string, Face>
  /** Takes the painted faces, PNG data URLs by key. */
  paint: (painted: Record<string, string>) => void
  /** Confirms the QR code on the phone: its next poll signs in `account`. */
  scan: (account: AccountKey) => void
  /** Signs `account` out on Bilibili's side, as an expired session would be. */
  expire: (account: AccountKey) => void
  /** The accounts with 收起未关注人消息 on, which the app's settings switch changes; none to begin with. */
  folding: Set<number>
  /** Every request the showcase had no answer for; a run fails on any. */
  unanswered: string[]
}

export function createShowcase(): Showcase {
  const unanswered: string[] = []
  let scanned: AccountKey | null = null
  const expired = new Set<number>()
  const folding = new Set<number>()
  /** Every picture the renderer may ask for, by path; the faces arrive once painted. */
  const pictures = new Map<string, Uint8Array<ArrayBuffer>>([[FAN_ART.path, FAN_ART.png]])

  const missing = (url: string): Response => {
    unanswered.push(url)
    return new Response(null, { status: 404 })
  }
  /** The account a request's cookie signs it in as. */
  const caller = (cookie: string): number | null => {
    const mid = /(?:^|;\s*)DedeUserID=(\d+)/.exec(cookie)?.[1]
    return mid === undefined ? null : Number(mid)
  }

  const showcaseFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    const mid = caller(new Headers(input instanceof Request ? input.headers : init?.headers).get('cookie') ?? '')
    const inbox = mid === ACCOUNTS.station.mid ? INBOX : []
    const ok = { code: 0, msg: '0', message: '0', ttl: 1 }

    // Each `data` is typed where it's written: `satisfies` on the reply wouldn't flag a field the app's
    // types no longer have inside a value built beforehand.
    switch (`${url.origin}${url.pathname}`) {
      case BILIBILI_ENDPOINTS.QR_GENERATE: {
        const data: BilibiliQRCodeGenerateResponse['data'] = { url: QR_URL, qrcode_key: QR_KEY }
        return Response.json({ ...ok, data } satisfies BilibiliQRCodeGenerateResponse)
      }
      case BILIBILI_ENDPOINTS.QR_POLL: {
        const confirmed = scanned
        scanned = null
        const data: BilibiliQRCodePollResponse['data'] =
          confirmed === null
            ? { url: '', refresh_token: '', timestamp: 0, code: QR_CODE_STATUS.WAITING_SCAN, message: '未扫码' }
            : {
                url: loginUrl(confirmed),
                refresh_token: 'showcase',
                timestamp: SHOWCASE_NOW,
                code: QR_CODE_STATUS.SUCCESS,
                message: '',
              }
        return Response.json({ ...ok, data } satisfies BilibiliQRCodePollResponse)
      }
      case BILIBILI_ENDPOINTS.NAV: {
        const entry = Object.entries(ACCOUNTS).find(([, a]) => a.mid === mid && !expired.has(a.mid))
        if (entry === undefined) {
          return Response.json({
            code: -101,
            message: '账号未登录',
            ttl: 1,
            data: { isLogin: false },
          } satisfies BilibiliNavResponse)
        }
        const [key, account] = entry
        const data: BilibiliNavResponse['data'] = {
          isLogin: true,
          mid: account.mid,
          uname: account.uname,
          face: faceUrl(key),
        }
        return Response.json({ ...ok, data } satisfies BilibiliNavResponse)
      }
      case BILIBILI_ENDPOINTS.GET_SESSIONS: {
        if (mid === null) return missing(url.href)
        // 未关注人 lists the chats unfollow_fold leaves out of the main list.
        const listed =
          url.searchParams.get('session_type') === String(SESSION_LIST_TYPE.UNFOLLOWED)
            ? inbox.filter(unfollowed)
            : url.searchParams.get('unfollow_fold') === '1'
              ? inbox.filter(c => !unfollowed(c))
              : inbox
        const data: BilibiliSessionsResponse['data'] = {
          session_list: listed.map(c => session(c, mid)),
          has_more: 0,
          anti_disturb_cleaning: false,
          is_address_list_empty: 0,
          show_level: false,
        }
        return Response.json({ ...ok, data } satisfies BilibiliSessionsResponse)
      }
      case BILIBILI_ENDPOINTS.FETCH_MESSAGES: {
        const id = Number(url.searchParams.get('talker_id'))
        const type = Number(url.searchParams.get('session_type'))
        const conversation = inbox.find(c => talker(c.key).id === id && talker(c.key).type === type)
        if (mid === null || conversation === undefined) return missing(url.href)
        const all = messages(conversation, mid)
        const data: BilibiliMessagesResponse['data'] = {
          // Newest first, as Bilibili pages them.
          messages: all.toReversed(),
          has_more: 0,
          min_seqno: all[0].msg_seqno,
          max_seqno: all[all.length - 1].msg_seqno,
          e_infos: [],
        }
        return Response.json({ ...ok, data } satisfies BilibiliMessagesResponse)
      }
      case BILIBILI_ENDPOINTS.USER_INFOS: {
        const uids = new Set((url.searchParams.get('uids') ?? '').split(',').map(Number))
        const data = Object.entries(PEOPLE)
          .filter(([, p]) => uids.has(p.mid))
          .map(([key, p]) => card(key, p))
        return Response.json({ ...ok, data } satisfies BilibiliUserCardsResponse)
      }
      case BILIBILI_ENDPOINTS.UPDATE_ACK:
        return Response.json(ok satisfies UpdateAckResponse)
      case BILIBILI_ENDPOINTS.SINGLE_UNREAD: {
        const data: BilibiliSingleUnreadResponse['data'] = {
          unfollow_unread: unreadOf(inbox.filter(unfollowed)),
          follow_unread: unreadOf(inbox.filter(c => !unfollowed(c))),
          unfollow_push_msg: 0,
          dustbin_push_msg: 0,
          dustbin_unread: 0,
          biz_msg_unfollow_unread: 0,
          biz_msg_follow_unread: 0,
          custom_unread: 0,
        }
        return Response.json({ ...ok, data } satisfies BilibiliSingleUnreadResponse)
      }
      case BILIBILI_ENDPOINTS.GET_LINK_SETTING: {
        if (mid === null) return missing(url.href)
        const data: BilibiliLinkSettingResponse['data'] = { show_unfollowed_msg: folding.has(mid) ? 1 : 0 }
        return Response.json({ ...ok, data } satisfies BilibiliLinkSettingResponse)
      }
      case BILIBILI_ENDPOINTS.SET_LINK_SETTING: {
        const setting = new URLSearchParams(String(init?.body ?? '')).get('show_unfollowed_msg')
        if (mid === null || setting === null) return missing(url.href)
        if (setting === '1') folding.add(mid)
        else folding.delete(mid)
        return Response.json(ok)
      }
      default:
        return missing(url.href)
    }
  }

  return {
    fetch: showcaseFetch,
    serve: request => {
      const url = new URL(request.url)
      const png = url.origin === PICTURE_ORIGIN ? pictures.get(url.pathname) : undefined
      if (png === undefined) return missing(request.url)
      return new Response(png, { headers: { 'content-type': 'image/png' } })
    },
    faces: FACES,
    paint: painted => {
      for (const [key, dataUrl] of Object.entries(painted)) {
        pictures.set(facePath(key), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
      }
    },
    scan: account => {
      scanned = account
    },
    expire: account => {
      expired.add(ACCOUNTS[account].mid)
    },
    folding,
    unanswered,
  }
}

/** The name the session list shows for a conversation. */
export function conversationName(key: ConversationKey): string {
  return key === 'fans' ? FAN_GROUP.name : PEOPLE[key].name
}

/** How many messages the chat header counts for a conversation. */
export function conversationLength(key: ConversationKey): number {
  return INBOX.find(c => c.key === key)?.lines.length ?? 0
}
