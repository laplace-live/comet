import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { QRGenerateResult, QRPollParams, QRPollResult, ReauthAccountResult } from '@/types/electron'

import { QR_CODE_STATUS } from '@/types/bilibili'

import { type UseQRCodeLoginOptions, type UseQRCodeLoginResult, useQRCodeLogin } from '@/hooks/useQRCodeLogin'

const globals = window as unknown as {
  IS_REACT_ACT_ENVIRONMENT: boolean
  __qrLoginTestResults: { tests: Array<{ name: string; ok: boolean; error?: string }> }
}
globals.IS_REACT_ACT_ENVIRONMENT = true

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const credentials = { SESSDATA: 'session', DedeUserID: 123, bili_jct: 'csrf' }
const generated = (key = 'key-1'): QRGenerateResult => ({
  code: 0,
  qrImageUrl: `data:image/png;base64,${key}`,
  data: { url: `https://example.com/${key}`, qrcode_key: key },
})
const polled = (code: number): QRPollResult => ({
  code: 0,
  data: { code, url: '', message: '', refresh_token: '', timestamp: 0 },
  ...(code === QR_CODE_STATUS.SUCCESS ? { credentials } : {}),
})

let now = 0
let nextTimer = 1
const timers = new Map<number, { at: number; callback: () => void }>()
window.setTimeout = ((callback: () => void, delay = 0) => {
  const id = nextTimer++
  timers.set(id, { at: now + delay, callback })
  return id
}) as typeof window.setTimeout
window.clearTimeout = ((id: number | undefined) => {
  if (id !== undefined) timers.delete(id)
}) as typeof window.clearTimeout

async function flush(callback: () => void = () => undefined) {
  await act(async () => {
    callback()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function advance(ms: number) {
  const end = now + ms
  for (;;) {
    const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
    if (!next) break
    timers.delete(next[0])
    now = next[1].at
    await flush(next[1].callback)
  }
  now = end
}

let current: UseQRCodeLoginResult
let root!: Root
let options: UseQRCodeLoginOptions
let successCalls: number
let pollCalls: QRPollParams[]
let generateImpl: () => Promise<QRGenerateResult>
let pollImpl: () => Promise<QRPollResult>
let reauthImpl: () => Promise<ReauthAccountResult>

function Harness(props: UseQRCodeLoginOptions) {
  current = useQRCodeLogin(props)
  return <output>{current.status}</output>
}

async function render(overrides: Partial<UseQRCodeLoginOptions> = {}) {
  options = { ...options, ...overrides }
  await flush(() => root.render(<Harness {...options} />))
}

async function setup(overrides: Partial<UseQRCodeLoginOptions> = {}) {
  timers.clear()
  now = 0
  successCalls = 0
  pollCalls = []
  generateImpl = async () => generated()
  pollImpl = async () => polled(QR_CODE_STATUS.WAITING_SCAN)
  reauthImpl = async () => ({ success: true })
  window.electronAPI = {
    bilibili: {
      qrGenerate: () => generateImpl(),
      qrPoll: (params: QRPollParams) => {
        pollCalls.push(params)
        return pollImpl()
      },
      reauthAccount: () => reauthImpl(),
    },
  } as unknown as typeof window.electronAPI
  options = {
    onSuccess: () => {
      successCalls++
    },
    ...overrides,
  }
  const container = document.createElement('div')
  document.body.replaceChildren(container)
  root = createRoot(container)
  await render()
}

const tests: Array<{ name: string; run: () => Promise<void> }> = []
function test(name: string, run: () => Promise<void>) {
  tests.push({ name, run })
}

test('scan, confirmation, and success complete once', async () => {
  await setup()
  assert(current.status === 'waiting_scan', 'generated QR should wait for scan')
  pollImpl = async () => polled(QR_CODE_STATUS.WAITING_CONFIRM)
  await advance(3000)
  assert(current.status === 'waiting_confirm', 'scanned QR should wait for confirmation')
  pollImpl = async () => polled(QR_CODE_STATUS.SUCCESS)
  await advance(3000)
  assert(current.status === 'success' && successCalls === 1, 'successful QR should notify once')
  await advance(12000)
  assert(pollCalls.length === 2 && timers.size === 0, 'success must stop polling')
})

test('a slow successful poll is never overlapped', async () => {
  await setup()
  const pending = deferred<QRPollResult>()
  pollImpl = () => pending.promise
  await advance(12000)
  assert(pollCalls.length === 1, 'only one IPC poll may be in flight')
  await flush(() => pending.resolve(polled(QR_CODE_STATUS.SUCCESS)))
  await advance(12000)
  assert(successCalls === 1 && pollCalls.length === 1, 'slow success must be consumed exactly once')
})

test('rerenders keep the poll schedule and use the latest success callback', async () => {
  await setup()
  let latestCalls = 0
  pollImpl = async () => polled(QR_CODE_STATUS.SUCCESS)
  await advance(1000)
  await render({
    onSuccess: () => {
      latestCalls++
    },
  })
  await advance(1000)
  await render({
    onSuccess: () => {
      latestCalls++
    },
  })
  await advance(1000)
  assert(pollCalls.length === 1 && latestCalls === 1 && successCalls === 0, 'rerender must not postpone the timer')
})

for (const [name, response] of [
  ['outer API failure', { code: -400, message: 'bad request' }],
  ['missing status', { code: 0 }],
  ['unknown status', polled(99999)],
  ['success without credentials', { ...polled(QR_CODE_STATUS.SUCCESS), credentials: undefined }],
] as const) {
  test(`${name} leaves confirmation with a retryable error`, async () => {
    await setup()
    pollImpl = async () => polled(QR_CODE_STATUS.WAITING_CONFIRM)
    await advance(3000)
    pollImpl = async () => response
    await advance(3000)
    assert(current.status === 'error' && !!current.error, 'failure must be visible instead of spinning')
    await advance(9000)
    assert(pollCalls.length === 2 && successCalls === 0, 'failure must stop polling')
  })
}

test('rejected IPC poll leaves confirmation with an error', async () => {
  await setup()
  pollImpl = async () => polled(QR_CODE_STATUS.WAITING_CONFIRM)
  await advance(3000)
  pollImpl = async () => {
    throw new Error('IPC failed')
  }
  await advance(3000)
  assert(current.status === 'error' && timers.size === 0, 'IPC rejection must stop the spinner')
})

test('failed login completion becomes a retryable error', async () => {
  await setup({
    onSuccess: async () => {
      throw new Error('Could not activate account')
    },
  })
  pollImpl = async () => polled(QR_CODE_STATUS.SUCCESS)
  await advance(3000)
  assert(current.status === 'error' && timers.size === 0, 'completion failure must not leave a success screen')
  assert(current.error === 'Could not activate account', 'the completion failure must be reported, not the poll')
})

test('refresh ignores an older poll success and polls the new key', async () => {
  await setup()
  const pending = deferred<QRPollResult>()
  pollImpl = () => pending.promise
  await advance(3000)
  generateImpl = async () => generated('key-2')
  await flush(() => {
    void current.generateQRCode()
  })
  await flush(() => pending.resolve(polled(QR_CODE_STATUS.SUCCESS)))
  assert(current.status === 'waiting_scan' && successCalls === 0, 'old success must not finish a refreshed QR')
  pollImpl = async () => polled(QR_CODE_STATUS.WAITING_CONFIRM)
  await advance(3000)
  assert(pollCalls[1].qrcodeKey === 'key-2', 'refresh must poll the replacement key')
})

test('refresh ignores an older QR generation response', async () => {
  await setup()
  const pending = deferred<QRGenerateResult>()
  generateImpl = () => pending.promise
  await flush(() => {
    void current.generateQRCode()
  })
  generateImpl = async () => generated('key-new')
  await flush(() => {
    void current.generateQRCode()
  })
  await flush(() => pending.resolve(generated('key-old')))
  assert(current.qrImageUrl?.endsWith('key-new'), 'older generation must not replace the current image')
  await advance(3000)
  assert(pollCalls[0].qrcodeKey === 'key-new', 'older generation must not replace the current key')
})

test('an older waiting response cannot overwrite a refreshed QR success', async () => {
  await setup()
  const pending = deferred<QRPollResult>()
  pollImpl = () => pending.promise
  await advance(3000)
  generateImpl = async () => generated('key-2')
  await flush(() => {
    void current.generateQRCode()
  })
  pollImpl = async () => polled(QR_CODE_STATUS.SUCCESS)
  await advance(3000)
  await flush(() => pending.resolve(polled(QR_CODE_STATUS.WAITING_CONFIRM)))
  assert(
    current.status === 'success' && successCalls === 1 && timers.size === 0,
    'stale waiting status must not restart polling'
  )
})

test('disabling ignores a pending generation and permits a clean reopen', async () => {
  await setup({ enabled: false })
  const pending = deferred<QRGenerateResult>()
  generateImpl = () => pending.promise
  await render({ enabled: true })
  await render({ enabled: false })
  await flush(() => pending.resolve(generated()))
  assert(
    current.status === 'loading' && current.qrImageUrl === null && timers.size === 0,
    'closed dialog must stay reset'
  )
  generateImpl = async () => generated('reopened')
  await render({ enabled: true })
  assert(current.qrImageUrl?.endsWith('reopened'), 'reopen should create a new QR')
})

test('unmount ignores an in-flight poll success', async () => {
  await setup()
  const pending = deferred<QRPollResult>()
  pollImpl = () => pending.promise
  await advance(3000)
  await flush(() => root.unmount())
  await flush(() => pending.resolve(polled(QR_CODE_STATUS.SUCCESS)))
  assert(successCalls === 0 && timers.size === 0, 'unmounted QR must not notify or schedule more polling')
})

test('wrong reauthentication account stops polling', async () => {
  await setup({ reauthAccount: { mid: 456, uname: 'expected' } })
  pollImpl = async () => polled(QR_CODE_STATUS.SUCCESS)
  reauthImpl = async () => ({ success: false, error: 'Credentials are for a different account', actualMid: 123 })
  await advance(3000)
  assert(pollCalls[0].skipSave === true, 'reauthentication must validate before saving')
  assert(
    current.status === 'wrong_account' && successCalls === 0 && timers.size === 0,
    'wrong account must be reported'
  )
})

test('closing during reauthentication ignores its completion', async () => {
  await setup({ reauthAccount: { mid: 123, uname: 'expected' } })
  const pending = deferred<ReauthAccountResult>()
  pollImpl = async () => polled(QR_CODE_STATUS.SUCCESS)
  reauthImpl = () => pending.promise
  await advance(3000)
  await render({ enabled: false })
  await flush(() => pending.resolve({ success: true }))
  assert(current.status === 'loading' && successCalls === 0 && timers.size === 0, 'closed reauth must ignore success')
})

test('expired QR stops polling', async () => {
  await setup()
  pollImpl = async () => polled(QR_CODE_STATUS.EXPIRED)
  await advance(3000)
  assert(current.status === 'expired' && timers.size === 0, 'expiration must stop polling')
})

void (async () => {
  const report: typeof globals.__qrLoginTestResults = { tests: [] }
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
  globals.__qrLoginTestResults = report
})()
