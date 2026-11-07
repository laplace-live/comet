import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { VirtuosoMockContext } from 'react-virtuoso'

import type { ChatOpening, EmojiInfoMap } from '@/hooks/usePrivateMessages'
import type { BilibiliMessage, BilibiliSession } from '@/types/bilibili'

import { MessagesPanel } from '@/components/comet/MessagesPanel'

const globals = window as unknown as {
  IS_REACT_ACT_ENVIRONMENT: boolean
  __rendererTestResults: { tests: Array<{ name: string; ok: boolean; error?: string }> }
}
globals.IS_REACT_ACT_ENVIRONMENT = true

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

const ME = 123
const FRIEND = 201

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

const said = (text: string) => ({ content: JSON.stringify({ content: text }) })

let root!: Root

async function flush(callback: () => unknown = () => undefined) {
  await act(async () => {
    await callback()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** Wait, flushing as it goes, until `ready` says so, or fail after `ms` */
async function until(ready: () => boolean, ms: number, what: string) {
  const start = Date.now()
  while (!ready()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`)
    await flush(() => new Promise(resolve => setTimeout(resolve, 50)))
  }
}

const tests: Array<{ name: string; run: () => Promise<void> }> = []
function test(name: string, run: () => Promise<void>) {
  tests.push({ name, run })
}

// The list draws rows in a hidden window only at the sizes Virtuoso is told
const drawn = { viewportHeight: 600, itemHeight: 60 }

/** Mount the chat panel alone, with a way to open a chat in it, from a search or otherwise */
function mountChat() {
  const container = document.createElement('div')
  // The page has no stylesheet, so the list is given the height the app's layout gives it
  const height = document.createElement('style')
  height.textContent = `[data-virtuoso-scroller] { height: ${drawn.viewportHeight}px !important }`
  document.body.replaceChildren(height, container)
  root = createRoot(container)

  /** The row of the chat's message at `index`, oldest first */
  const row = (index: number) => container.querySelector(`[data-index="${index}"]`)
  /** What's marked in the message at `index` */
  const marks = (index: number) => [...(row(index)?.querySelectorAll('mark') ?? [])].map(mark => mark.textContent)

  // Each opening mounts the list again, which draws its rows a few frames later
  const open = async (messages: BilibiliMessage[], chatOpening: ChatOpening, emojiInfoMap: EmojiInfoMap = {}) => {
    await flush(() =>
      root.render(
        <VirtuosoMockContext.Provider value={drawn}>
          <MessagesPanel
            selectedSession={session(FRIEND, messages.length)}
            chatOpening={chatOpening}
            messages={messages}
            emojiInfoMap={emojiInfoMap}
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
    )
    await until(() => messages.every((_, index) => !!row(index)), 2000, 'the messages to show')
  }

  return { container, row, marks, open }
}

test('a chat opened from a search marks the text in its messages, sent or received, each time and as written', async () => {
  const { row, marks, open } = mountChat()
  const messages = [
    message(FRIEND, 1, said('asdaf 还是 ASDAF？')),
    message(ME, 2, said('Asdaf，就是 asdaf')),
    message(FRIEND, 3, said('好的')),
  ]
  await open(messages, { id: 1, msgKey: '2000', query: 'asdaf' })

  assert(marks(0).join() === 'asdaf,ASDAF', `the message received should mark each, as written, got ${marks(0)}`)
  assert(marks(1).join() === 'Asdaf,asdaf', `the message sent should mark each, as written, got ${marks(1)}`)
  assert(marks(2).length === 0, `a message without the text should mark nothing, got ${marks(2)}`)
  assert(
    row(0)?.textContent?.includes('asdaf 还是 ASDAF？'),
    `the marks should leave the text as it was, got ${row(0)?.textContent}`
  )
  // The message it opened at stands out from the rest, as before
  assert(row(1)?.querySelector('[data-target]'), 'the message it opened at should stand out from the rest')
})

test('a chat opened otherwise marks nothing, though a search opened it before', async () => {
  const { container, open } = mountChat()
  const messages = [message(FRIEND, 1, said('asdaf')), message(ME, 2, said('asdaf 也是'))]
  const marked = () => container.querySelectorAll('mark').length

  await open(messages, { id: 1, msgKey: '1000', query: 'asdaf' })
  assert(marked() === 2, `opened from a search, it should mark the text, got ${marked()} marks`)

  await open(messages, { id: 2, msgKey: null, query: null })
  assert(marked() === 0, `opened otherwise, it should mark nothing, got ${marked()} marks`)
})

// An emoji's image, inline, so the page asks the network for nothing
const DOGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

test('an emoji shows as its image among the text marked around it, and a code with no emoji marks as text', async () => {
  const { row, marks, open } = mountChat()
  const emojiInfoMap: EmojiInfoMap = { '[tv_doge]': { text: '[tv_doge]', url: DOGE, size: 1 } }
  const messages = [message(FRIEND, 1, said('asdaf[tv_doge]asdaf')), message(ME, 2, said('[asdaf]不是表情'))]
  const emojis = (index: number) =>
    [...(row(index)?.querySelectorAll<HTMLImageElement>('p img') ?? [])].map(img => img.alt)

  await open(messages, { id: 1, msgKey: null, query: 'asdaf' }, emojiInfoMap)
  assert(emojis(0).join() === '[tv_doge]', `the emoji should show as its image, got ${emojis(0)}`)
  assert(marks(0).join() === 'asdaf,asdaf', `the text on either side of it should be marked, got ${marks(0)}`)
  assert(!row(0)?.querySelector('mark img'), 'the emoji should stay out of the marks')
  assert(
    emojis(1).length === 0 && marks(1).join() === 'asdaf',
    `a code with no emoji should show as text, marked, got ${marks(1)}`
  )

  // A search for such a code and the text after it marks them as one
  await open(messages, { id: 2, msgKey: null, query: '[asdaf]不是' }, emojiInfoMap)
  assert(marks(1).join() === '[asdaf]不是', `the code and the text after it should be marked as one, got ${marks(1)}`)
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
