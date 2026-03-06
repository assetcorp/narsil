import { describe, expect, it } from 'vitest'
import { generateId } from '../../core/id-generator'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('generateId', () => {
  it('produces a string matching UUID v7 format', () => {
    const id = generateId()
    expect(id).toMatch(UUID_REGEX)
  })

  it('has version nibble set to 7', () => {
    const id = generateId()
    expect(id[14]).toBe('7')
  })

  it('has the variant bits set to RFC 9562 (10xx)', () => {
    const id = generateId()
    const variantChar = id[19]
    expect(['8', '9', 'a', 'b']).toContain(variantChar)
  })

  it('generates unique IDs across 1000 calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      ids.add(generateId())
    }
    expect(ids.size).toBe(1000)
  })

  it('produces IDs that sort in roughly chronological order across different timestamps', async () => {
    const early = generateId()
    await new Promise(resolve => setTimeout(resolve, 5))
    const late = generateId()
    expect(early < late).toBe(true)
  })

  it('has exactly 36 characters (8-4-4-4-12 with hyphens)', () => {
    const id = generateId()
    expect(id.length).toBe(36)
    expect(id[8]).toBe('-')
    expect(id[13]).toBe('-')
    expect(id[18]).toBe('-')
    expect(id[23]).toBe('-')
  })

  it('embeds the current timestamp in the upper 48 bits', () => {
    const before = Date.now()
    const id = generateId()
    const after = Date.now()

    const hex = id.replace(/-/g, '')
    const timestampHex = hex.slice(0, 12)
    const timestamp = Number.parseInt(timestampHex, 16)

    expect(timestamp).toBeGreaterThanOrEqual(before)
    expect(timestamp).toBeLessThanOrEqual(after)
  })
})
