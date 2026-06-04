import { describe, expect, it } from 'vitest'

describe('vitest smoke', () => {
  it('runs and asserts true', () => {
    expect(true).toBe(true)
  })

  it('resolves the @ alias to src', async () => {
    // const.ts lives at src/lib/const.ts; importing via @ proves alias wiring
    const mod = await import('@/lib/const')
    expect(mod).toBeTypeOf('object')
  })
})
