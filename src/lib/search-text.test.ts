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

describe('extractSearchableText — recall & revoke', () => {
  it('REVOKE (msg_type 5) → empty text and no label (skipped)', () => {
    const content = JSON.stringify({ content: 'some recall trigger' })
    const result = extractSearchableText(content, MSG_TYPE.REVOKE)
    expect(result).toEqual({ text: '', typeLabel: null })
  })

  it('recalled TEXT (msgStatus===1) → text excluded, [已撤回的消息] label', () => {
    const content = JSON.stringify({ content: '原始内容不应被索引' })
    const result = extractSearchableText(content, MSG_TYPE.TEXT, 1)
    expect(result).toEqual({ text: '', typeLabel: '[已撤回的消息]' })
  })

  it('recall takes precedence over any msg_type label', () => {
    const content = JSON.stringify({ url: 'https://i0.hdslb.com/x.jpg' })
    const result = extractSearchableText(content, MSG_TYPE.IMAGE, 1)
    expect(result).toEqual({ text: '', typeLabel: '[已撤回的消息]' })
  })

  it('msgStatus 0 does not trigger recall handling', () => {
    const content = JSON.stringify({ content: '正常消息' })
    const result = extractSearchableText(content, MSG_TYPE.TEXT, 0)
    expect(result).toEqual({ text: '正常消息', typeLabel: null })
  })
})

describe('extractSearchableText — SHARE', () => {
  it('prefers sketch.title and sketch.desc_text, includes source', () => {
    const content = JSON.stringify({
      title: 'outer title',
      desc: 'outer desc',
      source: '来自哔哩哔哩',
      sketch: { title: '分享标题', desc_text: '分享描述', target_url: 'https://b23.tv/x' },
    })
    const result = extractSearchableText(content, MSG_TYPE.SHARE)
    expect(result.typeLabel).toBeNull()
    expect(result.text).toContain('分享标题')
    expect(result.text).toContain('分享描述')
    expect(result.text).toContain('来自哔哩哔哩')
    expect(result.text).not.toContain('outer title')
  })

  it('falls back to top-level title/desc when sketch is absent', () => {
    const content = JSON.stringify({ title: '顶层标题', desc: '顶层描述', source: '来源' })
    const result = extractSearchableText(content, MSG_TYPE.SHARE)
    expect(result.text).toContain('顶层标题')
    expect(result.text).toContain('顶层描述')
    expect(result.text).toContain('来源')
  })
})

describe('extractSearchableText — NOTIFICATION', () => {
  it('joins title, text, and each module title/detail', () => {
    const content = JSON.stringify({
      title: '系统通知标题',
      text: '通知正文内容',
      modules: [
        { title: '字段一', detail: '详情一' },
        { title: '字段二', detail: '详情二' },
      ],
    })
    const result = extractSearchableText(content, MSG_TYPE.NOTIFICATION)
    expect(result.typeLabel).toBeNull()
    expect(result.text).toContain('系统通知标题')
    expect(result.text).toContain('通知正文内容')
    expect(result.text).toContain('字段一')
    expect(result.text).toContain('详情一')
    expect(result.text).toContain('字段二')
    expect(result.text).toContain('详情二')
  })

  it('handles missing modules gracefully', () => {
    const content = JSON.stringify({ title: '仅标题', text: '仅正文' })
    const result = extractSearchableText(content, MSG_TYPE.NOTIFICATION)
    expect(result.text).toContain('仅标题')
    expect(result.text).toContain('仅正文')
  })
})

describe('extractSearchableText — VIDEO_PUSH', () => {
  it('joins title, desc, and attach_msg', () => {
    const content = JSON.stringify({
      title: '视频标题',
      desc: '视频简介',
      attach_msg: 'UP主赠言内容',
      bvid: 'BV1xx411',
    })
    const result = extractSearchableText(content, MSG_TYPE.VIDEO_PUSH)
    expect(result.typeLabel).toBeNull()
    expect(result.text).toContain('视频标题')
    expect(result.text).toContain('视频简介')
    expect(result.text).toContain('UP主赠言内容')
  })

  it('handles null attach_msg', () => {
    const content = JSON.stringify({ title: '只有标题', desc: '', attach_msg: null })
    const result = extractSearchableText(content, MSG_TYPE.VIDEO_PUSH)
    expect(result.text).toContain('只有标题')
  })
})

describe('extractSearchableText — SYSTEM_TIP', () => {
  it('double-parses content.content and joins each item text', () => {
    const inner = JSON.stringify([
      { text: '该用户已被', color_day: '#9499A0', color_nig: '#9499A0' },
      { text: '封禁', color_day: '#FB7299', color_nig: '#FB7299', jump_url: 'https://b.tv/x' },
    ])
    const content = JSON.stringify({ content: inner })
    const result = extractSearchableText(content, MSG_TYPE.SYSTEM_TIP)
    expect(result.typeLabel).toBeNull()
    expect(result.text).toContain('该用户已被')
    expect(result.text).toContain('封禁')
  })

  it('returns empty text when inner content is not a valid JSON array', () => {
    const content = JSON.stringify({ content: 'not-json' })
    const result = extractSearchableText(content, MSG_TYPE.SYSTEM_TIP)
    expect(result).toEqual({ text: '', typeLabel: null })
  })
})

describe('extractSearchableText — AI_GENERATED', () => {
  it('walks paragraphs[].text.nodes[] preferring raw_text, falling back to word.words', () => {
    const content = JSON.stringify({
      sub_type: 1,
      paragraphs: [
        {
          para_type: 1,
          text: {
            nodes: [
              { node_type: 1, raw_text: '你好，' },
              { node_type: 1, raw_text: '', word: { words: '世界' } },
            ],
          },
        },
        {
          para_type: 1,
          text: { nodes: [{ node_type: 1, raw_text: '第二段' }] },
        },
      ],
    })
    const result = extractSearchableText(content, MSG_TYPE.AI_GENERATED)
    expect(result.typeLabel).toBeNull()
    expect(result.text).toBe('你好，世界\n第二段')
  })

  it('returns empty text when paragraphs are missing or empty', () => {
    const content = JSON.stringify({ sub_type: 4, paragraphs: [] })
    const result = extractSearchableText(content, MSG_TYPE.AI_GENERATED)
    expect(result).toEqual({ text: '', typeLabel: null })
  })
})

describe('extractSearchableText — FAN_GROUP_SYSTEM', () => {
  it('extracts content.content text', () => {
    const content = JSON.stringify({ group_id: 12345, content: '欢迎 张三 加入粉丝团' })
    const result = extractSearchableText(content, MSG_TYPE.FAN_GROUP_SYSTEM)
    expect(result).toEqual({ text: '欢迎 张三 加入粉丝团', typeLabel: null })
  })

  it('falls back to whole-object extraction when content.content is absent', () => {
    const content = JSON.stringify({ text: '系统消息文本' })
    const result = extractSearchableText(content, MSG_TYPE.FAN_GROUP_SYSTEM)
    expect(result.text).toBe('系统消息文本')
  })
})

describe('extractSearchableText — generic fallback & plain string', () => {
  it('LOTTERY (13) uses generic precedence: content wins', () => {
    const content = JSON.stringify({ content: '抽奖内容', text: 'ignored', title: 'ignored' })
    const result = extractSearchableText(content, MSG_TYPE.LOTTERY)
    expect(result).toEqual({ text: '抽奖内容', typeLabel: null })
  })

  it('ARTICLE (22) falls back through title when content/text absent', () => {
    const content = JSON.stringify({ title: '专栏标题', desc: '专栏描述' })
    const result = extractSearchableText(content, MSG_TYPE.ARTICLE)
    expect(result.text).toBe('专栏标题')
  })

  it('LIVE_CARD (27) falls back to pure_text', () => {
    const content = JSON.stringify({ pure_text: '直播间纯文本' })
    const result = extractSearchableText(content, MSG_TYPE.LIVE_CARD)
    expect(result.text).toBe('直播间纯文本')
  })

  it('MINI_PROGRAM (21) falls back to abs_text when nothing higher present', () => {
    const content = JSON.stringify({ abs_text: '小程序摘要' })
    const result = extractSearchableText(content, MSG_TYPE.MINI_PROGRAM)
    expect(result.text).toBe('小程序摘要')
  })

  it('recurses into nested content object', () => {
    const content = JSON.stringify({ content: { content: '嵌套文本' } })
    const result = extractSearchableText(content, MSG_TYPE.LOTTERY)
    expect(result.text).toBe('嵌套文本')
  })

  it('plain (non-JSON) string content falls back to the raw string', () => {
    const result = extractSearchableText('就是一条纯文本', MSG_TYPE.TEXT)
    expect(result).toEqual({ text: '就是一条纯文本', typeLabel: null })
  })

  it('plain string on an unknown type falls back to the raw string', () => {
    const result = extractSearchableText('纯文本未知类型', 9999)
    expect(result.text).toBe('纯文本未知类型')
  })

  it('returns empty text for an unknown type with no extractable fields', () => {
    const content = JSON.stringify({ foo: 'bar', nested: { baz: 1 } })
    const result = extractSearchableText(content, 9999)
    expect(result).toEqual({ text: '', typeLabel: null })
  })
})
