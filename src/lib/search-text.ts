import { MSG_TYPE } from '@/types/bilibili'

export interface ExtractedText {
  text: string
  typeLabel: string | null
}

// Safely extract a string from any value, mirroring MessageBubble.extractTextContent
// precedence: content > text > title > desc > pure_text > abs_text (recurse into nested content).
function extractTextContent(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.content === 'string') return obj.content
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.title === 'string') return obj.title
    if (typeof obj.desc === 'string') return obj.desc
    if (typeof obj.pure_text === 'string') return obj.pure_text
    if (typeof obj.abs_text === 'string') return obj.abs_text
    if (obj.content && typeof obj.content === 'object') {
      return extractTextContent(obj.content)
    }
  }
  return ''
}

// Join non-empty parts with spaces into a single indexable string.
function joinParts(parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ')
}

/**
 * Extract indexable plain text and a synthetic type label from a raw message content blob.
 *
 * @param content Raw message.content (JSON string, sometimes a plain string).
 * @param msgType Numeric MSG_TYPE.
 * @param msgStatus 1 = recalled.
 */
export function extractSearchableText(content: string, msgType: number, msgStatus?: number): ExtractedText {
  // Recalled messages: content is excluded from the index; only the synthetic label is kept.
  if (msgStatus === 1) {
    return { text: '', typeLabel: '[已撤回的消息]' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    parsed = content
  }

  const obj = (parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >

  switch (msgType) {
    case MSG_TYPE.TEXT: {
      const text = extractTextContent(obj.content) || extractTextContent(obj)
      return { text, typeLabel: null }
    }

    case MSG_TYPE.IMAGE:
      return { text: '', typeLabel: '[图片]' }

    case MSG_TYPE.CUSTOM_EMOJI:
      return { text: '', typeLabel: '[表情]' }

    case MSG_TYPE.SHARE: {
      const sketch = (obj.sketch && typeof obj.sketch === 'object' ? obj.sketch : {}) as Record<string, unknown>
      const title = extractTextContent(sketch.title) || extractTextContent(obj.title)
      const desc = extractTextContent(sketch.desc_text) || extractTextContent(obj.desc)
      const source = extractTextContent(obj.source)
      return { text: joinParts([title, desc, source]), typeLabel: null }
    }

    case MSG_TYPE.REVOKE:
      return { text: '', typeLabel: null }

    default:
      return { text: '', typeLabel: null }
  }
}
