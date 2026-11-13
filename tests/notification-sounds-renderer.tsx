import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type {
  BilibiliMessage,
  BilibiliMessagesResponse,
  BilibiliSession,
  BilibiliSessionsResponse,
  BilibiliUserCardsResponse,
  CustomerServiceMessage,
  CustomerServiceSession,
} from '@/types/bilibili'
import type {
  CustomerServiceShop,
  FetchUsersParams,
  NewMessageNotification,
  NotificationSoundParams,
  PlayNotificationSoundEvent,
  ShowNotificationParams,
} from '@/types/electron'

import { CS_MSG_TYPE, CS_SENDER_TYPE, MSG_TYPE, SESSION_TYPE, SYSTEM_MSG_TYPE } from '@/types/bilibili'

import {
  DEFAULT_NOTIFICATION_SOUNDS,
  getNotificationSoundCategory,
  NOTIFICATION_SOUND_DEFAULT,
  NOTIFICATION_SOUND_NONE,
} from '@/lib/notification-sounds'
import { previewNotificationSound, resetSoundPlayerCache } from '@/lib/sound-player'

import { type UsePrivateMessagesReturn, usePrivateMessages } from '@/hooks/usePrivateMessages'

import { SettingsDialog } from '@/components/comet/SettingsDialog'

import App from '@/App'
import { useSettings } from '@/stores/useSettings'

const globals = window as unknown as {
  IS_REACT_ACT_ENVIRONMENT: boolean
  __rendererTestResults: { tests: Array<{ name: string; ok: boolean; error?: string }> }
}
globals.IS_REACT_ACT_ENVIRONMENT = true

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const ME = 123
const FRIEND = 456
const FAN_GROUP_ID = 888
const SYSTEM_TALKER_ID = 10001
const STORE_SHOP: CustomerServiceShop = { shopFatherId: 1, shopId: 9 }

function makeSession(overrides: Partial<BilibiliSession>): BilibiliSession {
  return {
    talker_id: 0,
    session_type: SESSION_TYPE.USER,
    at_seqno: 0,
    top_ts: 0,
    group_name: '',
    group_cover: '',
    is_follow: 1,
    is_dnd: 0,
    ack_seqno: 0,
    ack_ts: 0,
    session_ts: 1,
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

function makeInstantMsg(
  senderUid: number,
  receiverId: number,
  receiverType: number,
  msgType: number,
  text: string
): NonNullable<NewMessageNotification['instantMsg']> {
  return {
    senderUid,
    receiverType,
    receiverId,
    msgType,
    content: JSON.stringify({ content: text, title: text }),
    msgSeqno: 10,
    timestamp: 10,
    msgKey: '10',
  }
}

function makeCsMessage(text: string): CustomerServiceMessage {
  return {
    sender_info: {
      type: CS_SENDER_TYPE.CUSTOMER,
      uid: 0,
      shop_id: STORE_SHOP.shopId,
      shop_father_id: STORE_SHOP.shopFatherId,
      customer_id: 1,
      machine_session_id: 0,
      customer_session_id: 1,
      name: '店铺客服',
      pic_url: '',
      shop_homepage: '',
    },
    receiver_info: {
      type: CS_SENDER_TYPE.USER,
      uid: ME,
      shop_id: STORE_SHOP.shopId,
      shop_father_id: STORE_SHOP.shopFatherId,
      customer_id: 0,
      machine_session_id: 0,
      customer_session_id: 1,
      name: 'me',
      pic_url: '',
      shop_homepage: '',
    },
    msg_type: CS_MSG_TYPE.TEXT,
    content: JSON.stringify({ content: text }),
    msg_key: '900000000000000001',
    seq_no: '800000000000000001',
    timestamp: 10,
    msg_status: 0,
    msg_source: 6,
  }
}

let root: Root | undefined
let activeMessagesState: UsePrivateMessagesReturn | null = null

function PrivateMessagesHarness() {
  activeMessagesState = usePrivateMessages()
  return null
}

async function flush(callback: () => unknown = () => undefined) {
  await act(async () => {
    await callback()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const tests: Array<{ name: string; run: () => Promise<void> }> = []
function test(name: string, run: () => Promise<void>) {
  tests.push({ name, run })
}

test('getNotificationSoundCategory classifies direct chats, fan groups, system notices, and customer service', async () => {
  assert(
    getNotificationSoundCategory({ sessionType: SESSION_TYPE.USER, systemMsgType: 0, msgType: MSG_TYPE.TEXT }) ===
      'direct',
    'regular 1-on-1 user message should use direct sound category'
  )
  assert(
    getNotificationSoundCategory({ sessionType: SESSION_TYPE.FAN_GROUP, systemMsgType: 0, msgType: MSG_TYPE.TEXT }) ===
      'group',
    'fan group message should use group sound category'
  )
  assert(
    getNotificationSoundCategory({ sessionType: SESSION_TYPE.USER, systemMsgType: 4, msgType: MSG_TYPE.TEXT }) ===
      'system',
    'system session (system_msg_type > 0) should use system sound category'
  )
  assert(
    getNotificationSoundCategory({
      sessionType: SESSION_TYPE.USER,
      systemMsgType: 0,
      msgType: MSG_TYPE.NOTIFICATION,
    }) === 'system',
    'notification card message (MSG_TYPE.NOTIFICATION) should use system sound category'
  )
  assert(
    getNotificationSoundCategory({
      sessionType: SESSION_TYPE.FAN_GROUP,
      systemMsgType: 2,
      msgType: MSG_TYPE.TEXT,
    }) === 'system',
    'fan group session with positive systemMsgType should use system sound category'
  )
  assert(
    getNotificationSoundCategory({
      sessionType: SESSION_TYPE.FAN_GROUP,
      systemMsgType: 0,
      msgType: MSG_TYPE.NOTIFICATION,
    }) === 'system',
    'fan group notification card should use system sound category'
  )
  assert(
    getNotificationSoundCategory({
      sessionType: SESSION_TYPE.FAN_GROUP,
      systemMsgType: 0,
      msgType: MSG_TYPE.FAN_GROUP_SYSTEM,
    }) === 'system',
    'fan group system notice (MSG_TYPE.FAN_GROUP_SYSTEM) should use system sound category'
  )
  assert(
    getNotificationSoundCategory({ sessionType: SESSION_TYPE.USER, isCustomerService: true }) === 'system',
    'customer service notification should use system sound category'
  )
})

test('useSettings merges legacy persisted storage with default notification sounds and syncs system sound', async () => {
  const syncedPrefs: string[] = []
  window.electronAPI = {
    platform: 'darwin',
    notificationSounds: {
      listSystemSounds: async () => [],
      readSoundData: async () => null,
      preview: async () => undefined,
      setSystemSoundPref: async ({ soundId }: NotificationSoundParams) => {
        syncedPrefs.push(soundId)
      },
      onPlaySound: () => () => undefined,
    },
  } as unknown as typeof window.electronAPI

  // Simulate an existing user upgrading from a version prior to notificationSounds
  localStorage.setItem(
    'laplace-comet-settings',
    JSON.stringify({
      state: {
        developerMode: true,
        customerServiceMutedMids: [],
        keepChatsOnDevice: false,
      },
      version: 0,
    })
  )
  await useSettings.persist.rehydrate()

  const migrated = useSettings.getState()
  assert(migrated.developerMode === true, 'existing developerMode setting should be preserved')
  assert(migrated.keepChatsOnDevice === false, 'existing keepChatsOnDevice setting should be preserved')
  assert(
    migrated.notificationSounds.direct === 'custom:snd-sine-notification' &&
      migrated.notificationSounds.group === 'custom:snd-sine-toggle-on' &&
      migrated.notificationSounds.system === 'custom:snd-sine-transition-up',
    'missing notificationSounds should populate all 3 category defaults'
  )

  migrated.setNotificationSound('system', 'system:Glass.aiff')
  assert(
    useSettings.getState().notificationSounds.system === 'system:Glass.aiff',
    'system notification sound should update in store'
  )
  assert(
    syncedPrefs.length === 1 && syncedPrefs[0] === 'system:Glass.aiff',
    'updating system category should sync preference to main process'
  )
})

test('usePrivateMessages passes each category sound to showNotification for direct, group, system, and CS alerts', async () => {
  let onNewMessage!: (notification: NewMessageNotification) => void
  const shown: ShowNotificationParams[] = []

  const directSession = makeSession({
    talker_id: FRIEND,
    session_type: SESSION_TYPE.USER,
    account_info: { name: '好友阿绫', pic_url: '' },
  })
  const groupSession = makeSession({
    talker_id: FAN_GROUP_ID,
    session_type: SESSION_TYPE.FAN_GROUP,
    group_name: '星尘粉丝团',
  })
  const systemSession = makeSession({
    talker_id: SYSTEM_TALKER_ID,
    session_type: SESSION_TYPE.USER,
    system_msg_type: 1,
    account_info: { name: 'UP主小助手', pic_url: '' },
  })
  const csSessionRow = makeSession({
    talker_id: 0,
    session_type: SESSION_TYPE.USER,
    system_msg_type: SYSTEM_MSG_TYPE.CUSTOMER_SERVICE,
    account_info: { name: '客服消息', pic_url: '' },
    unread_count: 1,
  })
  const serverSessions = [directSession, groupSession, systemSession, csSessionRow]

  const csChat: CustomerServiceSession = {
    talker_info: {
      type: CS_SENDER_TYPE.CUSTOMER,
      uid: 0,
      shop_id: STORE_SHOP.shopId,
      shop_father_id: STORE_SHOP.shopFatherId,
      customer_id: 1,
      machine_session_id: 0,
      customer_session_id: 1,
      name: '会员购客服',
      pic_url: '',
      shop_homepage: '',
    },
    last_msg: makeCsMessage('您的订单已发货'),
    unread_info: { unread_count: 1 },
    session_ts: 10,
    max_seqno: '800000000000000001',
    top_set: 0,
    do_not_disturb: false,
    tag_name: '',
  }

  useSettings.setState({
    customerServiceMutedMids: [],
    notificationSounds: {
      direct: 'custom:snd-piano-button',
      group: 'system:Glass.aiff',
      system: NOTIFICATION_SOUND_NONE,
    },
  })

  window.electronAPI = {
    platform: 'darwin',
    setBadgeCount: async () => ({ success: true }),
    bilibili: {
      getAccounts: async () => ({ accounts: [{ mid: ME, uname: 'me', isExpired: false }], activeAccountMid: ME }),
      checkLogin: async () => ({ isLogin: true, mid: ME, uname: 'me' }),
      wsConnect: async () => ({ success: true }),
      wsDisconnect: async () => ({ success: true }),
      fetchSessions: async (): Promise<BilibiliSessionsResponse> => ({
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
      }),
      fetchMessages: async (): Promise<BilibiliMessagesResponse> => ({
        code: 0,
        msg: '0',
        message: '0',
        ttl: 1,
        data: { messages: [] as BilibiliMessage[], has_more: 0, min_seqno: 0, max_seqno: 0 },
      }),
      fetchUsers: async ({ uids }: FetchUsersParams): Promise<BilibiliUserCardsResponse> => ({
        code: 0,
        msg: '0',
        message: '0',
        ttl: 1,
        data: uids.split(',').map(uid => ({
          mid: Number(uid),
          name: `用户 ${uid}`,
          face: '',
          sign: '',
          rank: 0,
          level: 0,
          silence: 0,
          vip: { type: 0, status: 0, due_date: 0, nickname_color: '' },
          official: { role: 0, title: '', desc: '', type: -1 },
        })),
      }),
      customerService: {
        fetchSessions: async () => ({ code: 0, message: '0', data: { session_list: [csChat], has_more: 0 } }),
        fetchMessages: async () => ({
          code: 0,
          message: '0',
          data: { messages: [], has_more: 0, min_seqno: '0', max_seqno: '0' },
        }),
        sendMessage: async () => ({ code: 0, message: '0', data: { msg_key: '1' } }),
        updateAck: async () => ({ code: 0 }),
        uploadImage: async () => ({ success: true }),
      },
      showNotification: async (params: ShowNotificationParams) => {
        shown.push(params)
        return { shown: true }
      },
      onNewMessage: (cb: (notification: NewMessageNotification) => void) => {
        onNewMessage = cb
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
  await flush(() => root?.render(<PrivateMessagesHarness />))
  await flush(() => window.dispatchEvent(new Event('blur')))
  await flush(() => activeMessagesState?.fetchSessions())

  // 1. Direct user chat notification
  await flush(() =>
    onNewMessage({
      talkerId: FRIEND,
      sessionType: SESSION_TYPE.USER,
      instantMsg: makeInstantMsg(FRIEND, ME, SESSION_TYPE.USER, MSG_TYPE.TEXT, '你好！'),
    })
  )

  // 2. Fan group chat notification
  await flush(() =>
    onNewMessage({
      talkerId: FAN_GROUP_ID,
      sessionType: SESSION_TYPE.FAN_GROUP,
      instantMsg: makeInstantMsg(999, FAN_GROUP_ID, SESSION_TYPE.FAN_GROUP, MSG_TYPE.TEXT, '大家晚上好'),
    })
  )

  // 3. System session notification
  await flush(() =>
    onNewMessage({
      talkerId: SYSTEM_TALKER_ID,
      sessionType: SESSION_TYPE.USER,
      instantMsg: makeInstantMsg(SYSTEM_TALKER_ID, ME, SESSION_TYPE.USER, MSG_TYPE.NOTIFICATION, '稿件已通过审核'),
    })
  )

  // 4. Customer service notification (WS sessionType 4 = store customer service)
  await flush(() =>
    onNewMessage({
      talkerId: STORE_SHOP.shopId,
      sessionType: 4,
    })
  )

  assert(shown.length === 4, `expected 4 notifications, got ${shown.length}`)
  assert(shown[0].sound === 'custom:snd-piano-button', `direct chat sound mismatch: ${shown[0].sound}`)
  assert(shown[1].sound === 'system:Glass.aiff', `fan group sound mismatch: ${shown[1].sound}`)
  assert(shown[2].sound === NOTIFICATION_SOUND_NONE, `system session sound mismatch: ${shown[2].sound}`)
  assert(shown[3].sound === NOTIFICATION_SOUND_NONE, `customer service sound mismatch: ${shown[3].sound}`)
})

test('SettingsDialog renders accessible sound selectors, previews sounds, disables muted preview, and falls back foreign OS sounds', async () => {
  resetSoundPlayerCache()
  const previewCalls: string[] = []

  window.electronAPI = {
    platform: 'darwin',
    notificationSounds: {
      listSystemSounds: async () => [
        { id: 'system:Glass.aiff', label: 'Crystal (Glass)' },
        { id: 'system:Tink.aiff', label: 'Boop (Tink)' },
      ],
      readSoundData: async () => null,
      preview: async ({ soundId }: NotificationSoundParams) => {
        previewCalls.push(soundId)
      },
      setSystemSoundPref: async () => undefined,
      onPlaySound: () => () => undefined,
    },
  } as unknown as typeof window.electronAPI

  useSettings.setState({
    settingsOpen: true,
    notificationSounds: {
      direct: DEFAULT_NOTIFICATION_SOUNDS.direct,
      group: NOTIFICATION_SOUND_NONE,
      // Simulate a Windows sound ID migrated onto macOS
      system: 'system:Windows Notify Messaging.wav',
    },
  })

  const container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
  await flush(() => root?.render(<SettingsDialog accounts={[]} activeAccountMid={null} />))
  // Wait for listSystemSounds() promise to settle
  await flush()

  const directLabel = document.querySelector('label[for="notification-sound-direct"]')
  const groupLabel = document.querySelector('label[for="notification-sound-group"]')
  const systemLabel = document.querySelector('label[for="notification-sound-system"]')
  assert(directLabel?.textContent === '私信消息', 'direct category label should render')
  assert(groupLabel?.textContent === '粉丝团消息', 'group category label should render')
  assert(systemLabel?.textContent === '系统与其他通知', 'system category label should render')

  const directTrigger = document.getElementById('notification-sound-direct')
  const groupTrigger = document.getElementById('notification-sound-group')
  const systemTrigger = document.getElementById('notification-sound-system')
  assert(directTrigger?.textContent?.includes('正弦 · 清脆'), `direct trigger text: ${directTrigger?.textContent}`)
  assert(groupTrigger?.textContent?.includes('无（静音）'), `group trigger text: ${groupTrigger?.textContent}`)
  assert(
    systemTrigger?.textContent?.includes('系统默认'),
    `foreign OS sound should fall back to 系统默认, got: ${systemTrigger?.textContent}`
  )

  const directPreviewBtn = document.querySelector<HTMLButtonElement>('button[aria-label="试听私信消息提示音"]')
  const groupPreviewBtn = document.querySelector<HTMLButtonElement>('button[aria-label="试听粉丝团消息提示音"]')
  const systemPreviewBtn = document.querySelector<HTMLButtonElement>('button[aria-label="试听系统与其他通知提示音"]')
  assert(directPreviewBtn && !directPreviewBtn.disabled, 'direct preview button should be enabled')
  assert(groupPreviewBtn?.disabled, 'muted group preview button should be disabled')
  assert(systemPreviewBtn && !systemPreviewBtn.disabled, 'system preview button should be enabled')

  await flush(() => directPreviewBtn.click())
  assert(
    previewCalls.join(',') === DEFAULT_NOTIFICATION_SOUNDS.direct,
    `clicking direct preview should play ${DEFAULT_NOTIFICATION_SOUNDS.direct}, got ${JSON.stringify(previewCalls)}`
  )

  await flush(() => systemPreviewBtn.click())
  assert(
    previewCalls.join(',') === `${DEFAULT_NOTIFICATION_SOUNDS.direct},${NOTIFICATION_SOUND_DEFAULT}`,
    `clicking fallback system preview should play default, got ${JSON.stringify(previewCalls)}`
  )
})

test('Windows/Linux renderer sound player decodes WAV bytes via Web Audio and caches AudioBuffers', async () => {
  resetSoundPlayerCache()

  // Build a minimal valid 44.1kHz mono 16-bit PCM WAV buffer in memory
  const sampleCount = 256
  const dataBytes = sampleCount * 2
  const wav = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(wav)
  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // Mono
  view.setUint32(24, 44100, true)
  view.setUint32(28, 88200, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)

  let readCalls = 0
  const fallbackPreviewCalls: string[] = []
  window.electronAPI = {
    platform: 'win32',
    notificationSounds: {
      listSystemSounds: async () => [],
      readSoundData: async () => {
        readCalls++
        // Offset subarray to verify safe ArrayBuffer slicing before decodeAudioData
        const padded = new Uint8Array(wav.byteLength + 16)
        padded.set(new Uint8Array(wav), 8)
        return padded.subarray(8, 8 + wav.byteLength)
      },
      preview: async ({ soundId }: NotificationSoundParams) => {
        fallbackPreviewCalls.push(soundId)
      },
      setSystemSoundPref: async () => undefined,
      onPlaySound: () => () => undefined,
    },
  } as unknown as typeof window.electronAPI

  await previewNotificationSound('custom:snd-sine-notification')
  await previewNotificationSound('custom:snd-sine-notification')

  assert(readCalls === 1, `decoded AudioBuffer should be cached across plays, readCalls=${readCalls}`)
  assert(
    fallbackPreviewCalls.length === 0,
    `valid WAV playback on Windows should not fall back to shell.beep(), got ${JSON.stringify(fallbackPreviewCalls)}`
  )
})

test('SettingsDialog preserves saved system sound label on discovery error and retries when reopened', async () => {
  const listAttempts: string[] = []
  window.electronAPI = {
    platform: 'darwin',
    notificationSounds: {
      listSystemSounds: async () => {
        listAttempts.push('attempt')
        if (listAttempts.length === 1) {
          throw new Error('temporary discovery failure')
        }
        return [{ id: 'system:Glass.aiff', label: 'Crystal (Glass)' }]
      },
      readSoundData: async () => null,
      preview: async () => undefined,
      setSystemSoundPref: async () => undefined,
      onPlaySound: () => () => undefined,
    },
  } as unknown as typeof window.electronAPI

  useSettings.setState({
    settingsOpen: true,
    notificationSounds: {
      direct: DEFAULT_NOTIFICATION_SOUNDS.direct,
      group: DEFAULT_NOTIFICATION_SOUNDS.group,
      system: 'system:Glass.aiff',
    },
  })

  const container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
  await flush(() => root?.render(<SettingsDialog accounts={[]} activeAccountMid={null} />))
  await flush()

  assert(
    listAttempts.join(',') === 'attempt',
    `expected 1 discovery attempt on initial open, got ${listAttempts.length}`
  )
  assert(
    useSettings.getState().notificationSounds.system === 'system:Glass.aiff',
    'saved system sound preference must remain unchanged when discovery fails'
  )
  const systemTriggerAfterFail = document.getElementById('notification-sound-system')
  assert(
    systemTriggerAfterFail?.textContent?.includes('Glass') && !systemTriggerAfterFail.textContent.includes('系统默认'),
    `saved system sound should preserve fallback label 'Glass', got: ${systemTriggerAfterFail?.textContent}`
  )
  assert(
    document.body.textContent?.includes('暂时无法读取系统音效列表') === true,
    'SettingsDialog should display a discovery error hint while system sounds are unavailable'
  )

  // Close and reopen SettingsDialog -> discovery should retry and upgrade label to Crystal (Glass)
  await flush(() => useSettings.getState().closeSettings())
  await flush(() => useSettings.getState().openSettings())
  await flush()

  assert(listAttempts.join(',') === 'attempt,attempt', `expected discovery retry on reopen, got ${listAttempts.length}`)
  const systemTriggerAfterRetry = document.getElementById('notification-sound-system')
  assert(
    systemTriggerAfterRetry?.textContent?.includes('Crystal (Glass)') === true,
    `reopened SettingsDialog should display discovered label 'Crystal (Glass)', got: ${systemTriggerAfterRetry?.textContent}`
  )
  assert(
    document.body.textContent?.includes('暂时无法读取系统音效列表') === false,
    'discovery error hint should clear once retry succeeds'
  )
})

test('App notification sound listener falls back to default sound when renderer playback fails', async () => {
  resetSoundPlayerCache()
  let onPlaySoundHandler: ((event: PlayNotificationSoundEvent) => void) | undefined
  const fallbackPreviewCalls: string[] = []

  window.electronAPI = {
    platform: 'win32',
    onOpenAbout: () => () => undefined,
    onOpenSettings: () => () => undefined,
    onUpdateStatus: () => () => undefined,
    getVersion: async () => '1.7.1',
    setBadgeCount: async () => ({ success: true }),
    bilibili: {
      getAccounts: async () => ({ accounts: [], activeAccountMid: null }),
      checkLogin: async () => ({ isLogin: false }),
      generateQrCode: async () => ({
        qrcodeKey: 'k',
        url: 'https://example.com',
        imageDataUrl: 'data:image/png;base64,',
      }),
      pollQrCode: async () => ({ status: 'waiting' }),
      wsConnect: async () => ({ success: true }),
      wsDisconnect: async () => ({ success: true }),
      onNewMessage: () => () => undefined,
      onSessionUpdate: () => () => undefined,
      onWsConnected: () => () => undefined,
      onWsDisconnected: () => () => undefined,
      onNavigateToSession: () => () => undefined,
    },
    notificationSounds: {
      listSystemSounds: async () => [],
      readSoundData: async () => null,
      preview: async ({ soundId }: NotificationSoundParams) => {
        fallbackPreviewCalls.push(soundId)
      },
      setSystemSoundPref: async () => undefined,
      onPlaySound: (cb: (event: PlayNotificationSoundEvent) => void) => {
        onPlaySoundHandler = cb
        return () => undefined
      },
    },
  } as unknown as typeof window.electronAPI

  const container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
  await flush(() => root?.render(<App />))
  assert(typeof onPlaySoundHandler === 'function', 'App should register notificationSounds.onPlaySound listener')

  await flush(() => onPlaySoundHandler?.({ soundId: 'custom:snd-sine-notification' }))
  await flush()

  assert(
    fallbackPreviewCalls.join(',') === NOTIFICATION_SOUND_DEFAULT,
    `failed renderer notification sound should fall back to default preview, got ${JSON.stringify(fallbackPreviewCalls)}`
  )
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
      const mounted = root
      root = undefined
      if (mounted) {
        await flush(() => mounted.unmount())
      }
    }
  }
  globals.__rendererTestResults = report
})()
