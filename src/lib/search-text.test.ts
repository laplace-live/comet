import { describe, expect, it } from 'vitest'

import { MSG_TYPE } from '@/types/bilibili'

import { extractSearchableText } from './search-text'

describe('extractSearchableText — TEXT', () => {
  it('returns content.content text with no type label', () => {
    const content = JSON.stringify({ content: '你好世界' })
    const result = extractSearchableText(content, MSG_TYPE.TEXT)
    expect(result).toEqual({ text: '你好世界', typeLabel: null })
  })

  it('keeps [emoji] codes as literal text', () => {
    const content = JSON.stringify({ content: '哈哈[tv_doge]测试[口罩]' })
    const result = extractSearchableText(content, MSG_TYPE.TEXT)
    expect(result.text).toBe('哈哈[tv_doge]测试[口罩]')
    expect(result.typeLabel).toBeNull()
  })
})

describe('extractSearchableText — label-only types', () => {
  it('IMAGE → empty text with [图片] label', () => {
    const content = JSON.stringify({ url: 'https://i0.hdslb.com/x.jpg', width: 100, height: 100 })
    const result = extractSearchableText(content, MSG_TYPE.IMAGE)
    expect(result).toEqual({ text: '', typeLabel: '[图片]' })
  })

  it('CUSTOM_EMOJI → empty text with [表情] label', () => {
    const content = JSON.stringify({ url: 'https://i0.hdslb.com/e.png', width: 60, height: 60 })
    const result = extractSearchableText(content, MSG_TYPE.CUSTOM_EMOJI)
    expect(result).toEqual({ text: '', typeLabel: '[表情]' })
  })
})
