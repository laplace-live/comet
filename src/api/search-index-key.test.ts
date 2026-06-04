import { describe, expect, it } from 'vitest'

import type { SafeStorageLike } from '@/api/search-index-key'

import { generateKeyHex, resolveKeyHex, unwrapKey, wrapKey } from '@/api/search-index-key'

// Fake safeStorage: reversible "encryption" via a prefix so we can assert round-trip in Node.
function makeFakeSafeStorage(available = true): SafeStorageLike {
  const PREFIX = 'enc:'
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(PREFIX + plain, 'utf-8'),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf-8')
      if (!s.startsWith(PREFIX)) throw new Error('not encrypted by this backend')
      return s.slice(PREFIX.length)
    },
  }
}

describe('generateKeyHex', () => {
  it('returns 64 lowercase hex chars (32 bytes)', () => {
    const hex = generateKeyHex()
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns a different value each call', () => {
    expect(generateKeyHex()).not.toBe(generateKeyHex())
  })
})

describe('wrapKey / unwrapKey', () => {
  it('round-trips a key hex through the fake safeStorage', () => {
    const safe = makeFakeSafeStorage()
    const hex = generateKeyHex()
    const wrapped = wrapKey(hex, safe)
    expect(typeof wrapped).toBe('string')
    expect(wrapped).not.toContain(hex) // wrapped blob must not expose the raw key verbatim
    const out = unwrapKey(wrapped, safe)
    expect(out).toBe(hex)
  })

  it('unwrap throws when the blob was wrapped by a different backend', () => {
    const safe = makeFakeSafeStorage()
    expect(() => unwrapKey(Buffer.from('garbage').toString('base64'), safe)).toThrow()
  })

  it('wrap falls back to plain base64 when encryption is unavailable', () => {
    const safe = makeFakeSafeStorage(false)
    const hex = generateKeyHex()
    const wrapped = wrapKey(hex, safe)
    // Fallback path stores the hex as plain base64; unwrap recovers it.
    expect(unwrapKey(wrapped, safe)).toBe(hex)
  })
})

describe('resolveKeyHex', () => {
  it('generates + persists on first call, then returns the same key on the second call', () => {
    const safe = makeFakeSafeStorage()
    const store = new Map<string, string>()
    const io = {
      read: (k: string) => store.get(k) ?? null,
      write: (k: string, v: string) => {
        store.set(k, v)
      },
    }
    const first = resolveKeyHex(safe, io)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(store.size).toBe(1) // persisted exactly one wrapped blob
    const second = resolveKeyHex(safe, io)
    expect(second).toBe(first) // stable across calls (reads the persisted blob)
  })
})
