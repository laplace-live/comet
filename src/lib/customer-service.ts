import type { BilibiliMessage, CustomerServiceMessage, CustomerServiceSession } from '@/types/bilibili'
import type { CustomerServiceShop } from '@/types/electron'

import { CS_MSG_TYPE, SESSION_TYPE } from '@/types/bilibili'

// Customer service chats (客服消息) run on their own backend, one chat per shop. Their messages
// mostly have types of their own, so this turns each into one of a few shapes the bubble draws.
// Texts and fallbacks follow Bilibili's web client.

export function getCustomerServiceShop(session: CustomerServiceSession): CustomerServiceShop {
  return { shopFatherId: session.talker_info.shop_father_id, shopId: session.talker_info.shop_id }
}

export function isSameShop(a: CustomerServiceShop | null, b: CustomerServiceShop | null): boolean {
  return !!a && !!b && a.shopFatherId === b.shopFatherId && a.shopId === b.shopId
}

/** The chat a WebSocket notification names, read as the web client does: type 4 is a store's, talkerId its shop */
export function getNotifiedShop(notification: { talkerId: number; sessionType: number }): CustomerServiceShop {
  return { shopFatherId: notification.sessionType === 4 ? 1 : 0, shopId: notification.talkerId || 0 }
}

/**
 * Whether a page's min_seqno moves the cursor back from the last one, so paging always ends
 * whatever the server sends (an empty page's 0, a repeat). Seqnos stay strings past Number.MAX_SAFE_INTEGER.
 */
export function isEarlierSeqno(seqno: string | undefined, before: string | undefined): seqno is string {
  if (!seqno || !/^\d+$/.test(seqno)) return false
  const value = BigInt(seqno)
  return value > 0n && (before === undefined || value < BigInt(before))
}

/**
 * The messages shown with the newest pages merged in by msg_key. The pages say where each of theirs goes,
 * so one that landed before a message sent from here goes before it, and a shown one the server has
 * changed since (a choice the bot recorded as picked) takes the server's copy. Messages sent from here
 * that no page holds yet stay last.
 * @param pages - oldest first, ending with the newest
 */
export function mergeCustomerServiceMessages(shown: BilibiliMessage[], pages: BilibiliMessage[]): BilibiliMessage[] {
  const keyOf = (message: BilibiliMessage) => String(message.msg_key)
  const fetched = new Set(pages.map(keyOf))
  const shownByKey = new Map(shown.map(m => [keyOf(m), m]))
  // Shown messages before the first one the pages hold are older than all of them
  const first = shown.findIndex(m => fetched.has(keyOf(m)))
  const merged = [
    ...(first === -1 ? shown : shown.slice(0, first)),
    ...pages.map(m => {
      const same = shownByKey.get(keyOf(m))
      return same && same.content === m.content && same.msg_status === m.msg_status ? same : m
    }),
    ...(first === -1 ? [] : shown.slice(first).filter(m => !fetched.has(keyOf(m)))),
  ]
  return merged.length === shown.length && merged.every((m, i) => m === shown[i]) ? shown : merged
}

/** A customer service message in the shape the message list draws */
export function toDisplayMessage(message: CustomerServiceMessage): BilibiliMessage {
  return {
    // The user's own messages carry their mid, which is what marks a message as sent
    sender_uid: message.sender_info.uid,
    receiver_type: SESSION_TYPE.USER,
    receiver_id: message.receiver_info.uid,
    msg_type: message.msg_type,
    content: message.content,
    // seq_no exceeds Number.MAX_SAFE_INTEGER, so this is only approximate: compare msg_key instead
    msg_seqno: Number(message.seq_no),
    timestamp: message.timestamp,
    at_uids: null,
    msg_key: message.msg_key,
    msg_status: message.msg_status,
    notify_code: '',
    // Customer service has sources of its own, which the source labels would misname
    msg_source: 0,
    customer_service_sender: {
      type: message.sender_info.type,
      name: message.sender_info.name,
      face: message.sender_info.pic_url,
    },
  }
}

export interface CustomerServiceLink {
  text: string
  url: string
}

/** The message that picking one of the bot's suggestions sends */
export interface CustomerServiceReply {
  msgType: number
  content: string
}

export interface CustomerServiceChoice {
  text: string
  reply: CustomerServiceReply
  /** Picked already, for choices that work once */
  picked?: boolean
}

export type CustomerServiceContent =
  | { kind: 'text'; text: string; image?: string; link?: CustomerServiceLink }
  // Questions, businesses or a human agent to pick, which send a reply of their own
  | {
      kind: 'choices'
      text: string
      choices: CustomerServiceChoice[]
      // Businesses and the human agent can be picked once; done once one is
      once?: { done: boolean }
      link?: CustomerServiceLink
    }
  | { kind: 'image'; url: string; width?: number; height?: number }
  | { kind: 'video'; title?: string; cover?: string; url?: string }
  | { kind: 'card'; title: string; details: Array<{ label: string; value: string }>; link?: CustomerServiceLink }
  // Drawn centred, without a bubble
  | { kind: 'notice'; text: string; link?: CustomerServiceLink }
  // Withdrawal events, which only exist to retract another message
  | { kind: 'hidden' }

type Json = Record<string, unknown>

function parseJson(value: unknown): Json {
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(object) : []
}

function link(url: unknown, text: string): CustomerServiceLink | undefined {
  const href = string(url)
  return /^(https?:)?\/\//.test(href) ? { text, url: href.startsWith('//') ? `https:${href}` : href } : undefined
}

/** The questions a problem list offers; picking one asks it, citing the message that offered it */
function questions(problems: unknown, msgKey: string): CustomerServiceChoice[] {
  return list(problems)
    .filter(problem => string(problem.intent))
    .map(problem => ({
      text: string(problem.intent),
      reply: {
        msgType: CS_MSG_TYPE.MACHINE_QUESTION,
        content: JSON.stringify({ problem_id: problem.problem_id, content: string(problem.intent), msg_key: msgKey }),
      },
    }))
}

/**
 * Text of an HTML snippet, for answers that only come as markup.
 * Parsed, never rendered: a parsed document runs no scripts and loads nothing.
 */
function plainText(html: string): string {
  const { body } = new DOMParser().parseFromString(html, 'text/html')
  for (const br of body.querySelectorAll('br')) br.replaceWith('\n')
  for (const paragraph of body.querySelectorAll('p')) paragraph.append('\n')
  return (body.textContent ?? '').replace(/\u00a0/g, ' ').trim()
}

// The bot's answer (MACHINE_ANSWER), shaped by content.type
function parseMachineAnswer(content: Json, msgKey: string): CustomerServiceContent {
  const desktopUnsupported = '[电脑端不支持该类型内容，请至APP查看]'
  switch (content.type) {
    case 0: {
      const answer = object(content.content)
      const images = Array.isArray(answer.img) ? answer.img : []
      return {
        kind: 'text',
        // pure_text is the whole answer; abs_text is a cut-down abstract, sometimes in HTML
        text: string(answer.pure_text) || plainText(string(answer.abs_text)) || '收到一条智能问答消息',
        image: string(images[0]) || undefined,
        link: link(answer.more_url, '查看详情'),
      }
    }
    case 1:
      return { kind: 'text', text: desktopUnsupported }
    case 2: {
      const relation = object(content.relation)
      return {
        kind: 'choices',
        text: string(relation.message) || '你咨询的相关联问题',
        choices: questions(relation.problems, msgKey),
      }
    }
    case 3: {
      const recommend = object(content.recommend)
      return {
        kind: 'choices',
        text: string(recommend.message) || '你可能还想了解',
        choices: questions(recommend.problems, msgKey),
      }
    }
    case 4:
      return {
        kind: 'choices',
        text: '对不起，暂时无法解决你的问题，可以联系人工客服替您解答哦！',
        choices: [
          {
            text: '转接人工',
            picked: content.selected === 1,
            reply: {
              msgType: CS_MSG_TYPE.SPLIT_QUESTION,
              content: JSON.stringify({ msg_key: msgKey, type: 0, content: '转接人工' }),
            },
          },
        ],
        once: { done: !!content.selected },
      }
    case 5: {
      const workOrder = object(content.ai_work_order)
      return {
        kind: 'text',
        text: string(workOrder.text) || '小助手已经悉知您的问题，该问题可能需要进一步反馈给相应的工作人员查询或处理。',
        link: link(workOrder.web_jump_url, '查看详情'),
      }
    }
    case 6:
      return {
        kind: 'text',
        text: string(object(content.ai_hit_cus).for_c) || '您的问题需要人工客服解答，为您转接更专业的服务，请稍候...',
      }
    default:
      return { kind: 'text', text: desktopUnsupported }
  }
}

// Businesses (type 0) or groups (type 1) to pick from, once; picking one names it in a SPLIT_QUESTION
function branches(content: Json, msgKey: string, fallback: string): CustomerServiceContent {
  const isBusiness = content.type === 0
  const nameOf = (item: Json) => string(isBusiness ? item.business_name : item.group_name)
  const items = list(isBusiness ? content.business_list : content.group_list).filter(item => nameOf(item))
  return {
    kind: 'choices',
    text: string(content.message) || fallback,
    choices: items.map(item => {
      const name = nameOf(item)
      return {
        text: name,
        picked: item.select === 1,
        reply: {
          msgType: CS_MSG_TYPE.SPLIT_QUESTION,
          content: JSON.stringify({
            type: isBusiness ? 1 : 2,
            content: name,
            msg_key: msgKey,
            ...(isBusiness ? { business_id: item.business_id } : { group_id: item.group_id }),
          }),
        },
      }
    }),
    once: { done: items.some(item => !!item.select) },
  }
}

// Business choices or the human agent queue (SPLIT_ANSWER), shaped by content.type
function parseSplitAnswer(content: Json, msgKey: string): CustomerServiceContent {
  switch (content.type) {
    case 0:
      return branches(content, msgKey, '请选择要咨询的业务')
    case 1:
      return branches(content, msgKey, '请选择')
    case 2: {
      const customer = object(content.customer_info)
      const state = customer.customer_state
      const description = string(customer.customer_state_desc)
      // Taken by an agent, or left the queue: notices, like the web client draws them
      if (state === 2 || state === 3 || state === 9) {
        return { kind: 'notice', text: description || `【${string(customer.customer_name)}】已接受了您的请求` }
      }
      if (state === 6 || state === 7 || state === 10) {
        return { kind: 'notice', text: description || '【您已退出排队】' }
      }
      const fallback =
        state === 1
          ? '目前排队人数过多，无法为您服务，可以点击“我要留言”描述您的问题，我们会尽快为您进行处理。'
          : state === 4 || state === 5
            ? '目前排队人数过多，预计等待时间比较久，您可以继续等待或者先留言，我们会尽快为您进行处理。'
            : '当前无在线客服，请您稍后再试，或者您可以选择留言功能进行留言，我们会尽快为您进行处理。'
      return { kind: 'text', text: description || fallback, link: link(customer.customer_ticket_url, '我要留言') }
    }
    case 3: {
      const notice = object(content.business_other)
      return {
        kind: 'text',
        text: string(notice.content) || '收到一条通知消息~',
        link: link(notice.jump_url, '查看详情'),
      }
    }
    default:
      return { kind: 'notice', text: string(content.message) || '[不支持的消息类型]' }
  }
}

// PARAGRAPH_TEXT, whose paragraphs hold word nodes like the AI messages in direct chats
function paragraphText(content: Json): string {
  return list(content.paragraphs)
    .map(paragraph =>
      list(object(paragraph.text).nodes)
        .map(node => string(node.raw_text) || string(object(node.word).words))
        .join('')
    )
    .filter(Boolean)
    .join('\n')
}

/** msg_key is only needed for the replies its choices send */
export function parseCustomerServiceContent(
  message: Pick<BilibiliMessage, 'msg_type' | 'content'> & Partial<Pick<BilibiliMessage, 'msg_key'>>
): CustomerServiceContent {
  const content = parseJson(message.content)
  const msgKey = String(message.msg_key ?? '')

  switch (message.msg_type) {
    case CS_MSG_TYPE.TEXT:
      return { kind: 'text', text: string(content.content) }
    case CS_MSG_TYPE.IMAGE:
    case CS_MSG_TYPE.FAV_EMOJI:
      return {
        kind: 'image',
        url: string(content.url),
        width: Number(content.width) || undefined,
        height: Number(content.height) || undefined,
      }
    case CS_MSG_TYPE.WITHDRAW:
      return { kind: 'hidden' }
    case CS_MSG_TYPE.VIDEO:
      return { kind: 'video', cover: string(content.img) || undefined, url: string(content.video_url) || undefined }
    case CS_MSG_TYPE.MACHINE_ANSWER:
      return parseMachineAnswer(content, msgKey)
    case CS_MSG_TYPE.MACHINE_QUESTION:
    case CS_MSG_TYPE.SPLIT_QUESTION:
      return { kind: 'text', text: string(content.content) || '您选择的是' }
    case CS_MSG_TYPE.MACHINE_WELCOME_TEXT:
      return { kind: 'text', text: string(content.message) || '您好，请问有什么可以帮您的？' }
    case CS_MSG_TYPE.MACHINE_WELCOME_QUESTIONS:
      return {
        kind: 'choices',
        text: string(content.message) || '猜你想问',
        choices: questions(content.problem_list ?? object(list(content.tab_problem_list)[0]).problem_list, msgKey),
        link: link(content.problem_more_url, '更多问题'),
      }
    case CS_MSG_TYPE.SPLIT_ANSWER:
      return parseSplitAnswer(content, msgKey)
    case CS_MSG_TYPE.OUT_CUSTOMER_SESSION:
      return { kind: 'notice', text: string(content.message) || '会话已结束' }
    case CS_MSG_TYPE.QUEUE_NOTICE:
      return {
        kind: 'text',
        text: string(content.message) || '收到一条通知消息~',
        link: link(content.customer_ticket_url, '我要留言'),
      }
    case CS_MSG_TYPE.SYS_NOTE: {
      const items = list(content.content)
      return {
        kind: 'notice',
        text: items.map(item => string(item.text)).join('') || '[系统提示]',
        link: items.map(item => link(item.url, string(item.text) || '查看详情')).find(Boolean),
      }
    }
    case CS_MSG_TYPE.PARAGRAPH_TEXT:
      return { kind: 'text', text: paragraphText(content) || '收到一条智能回答消息~' }
    case CS_MSG_TYPE.ORDER:
      return { kind: 'card', title: '[订单]', details: [], link: link(content.abs_url, '查看订单') }
    case CS_MSG_TYPE.GOODS:
      return { kind: 'card', title: '[商品]', details: [], link: link(content.abs_url, '查看商品') }
    case CS_MSG_TYPE.TICKET: {
      // Ticket ids pass Number.MAX_SAFE_INTEGER, so they're read as written, as the web client reads them
      const ticket = parseJson(String(message.content).replace(/("id"\s*:\s*)(\d+)/g, '$1"$2"'))
      return {
        kind: 'card',
        title: string(ticket.title) || '[留言通知]',
        details: [
          { label: '创建人', value: string(ticket.create_name) },
          { label: '创建时间', value: string(ticket.create_time) },
          { label: '留言ID', value: string(ticket.id) },
          { label: '用户诉求', value: string(ticket.user_expect) },
        ].filter(detail => detail.value),
        link: link(ticket.jump_url, '查看留言'),
      }
    }
    case CS_MSG_TYPE.ARCHIVE:
      return {
        kind: 'video',
        title: string(content.title) || undefined,
        cover: string(content.cover) || undefined,
        url: string(content.url) || undefined,
      }
    case CS_MSG_TYPE.EVALUATION:
      return {
        kind: 'notice',
        text:
          content.feedback && !content.step_select
            ? string(content.feedback)
            : content.level
              ? '您已完成服务评价'
              : '[服务评价]',
      }
    case CS_MSG_TYPE.CUSTOMER_INVITE_EVALUATION:
    case CS_MSG_TYPE.MACHINE_SESSION_EVALUATION: {
      const evaluation = object(content.evaluation_v2)
      const done = 'evaluation_v2' in content ? !!evaluation.evaluation_data : !!object(content.evaluation).done
      return { kind: 'notice', text: done ? '您已完成服务评价' : '您有一个服务待评价' }
    }
    default:
      return { kind: 'notice', text: string(content.message) || string(content.content) || '[不支持的消息类型]' }
  }
}

/** One line of text for a customer service message: list previews, notifications, copying */
export function getCustomerServicePreview(message: Pick<BilibiliMessage, 'msg_type' | 'content'>): string {
  const content = parseCustomerServiceContent(message)
  switch (content.kind) {
    case 'text':
    case 'choices':
    case 'notice':
      return content.text
    case 'image':
      return message.msg_type === CS_MSG_TYPE.FAV_EMOJI ? '[自定义表情]' : '[图片]'
    case 'video':
      return content.title ? `[视频] ${content.title}` : '[视频]'
    case 'card':
      return content.title
    case 'hidden':
      return ''
  }
}
