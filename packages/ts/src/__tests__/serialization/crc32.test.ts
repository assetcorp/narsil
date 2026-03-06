import { describe, expect, it } from 'vitest'
import { crc32 } from '../../serialization/crc32'

describe('crc32', () => {
  it('returns 0x00000000 for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0x00000000)
  })

  it('returns 0xCBF43926 for ASCII "123456789"', () => {
    const input = new TextEncoder().encode('123456789')
    expect(crc32(input)).toBe(0xcbf43926)
  })

  it('produces consistent results for identical inputs', () => {
    const input = new TextEncoder().encode('narsil search engine')
    const first = crc32(input)
    const second = crc32(input)
    expect(first).toBe(second)
  })

  it('produces different results for different inputs', () => {
    const a = crc32(new TextEncoder().encode('alpha'))
    const b = crc32(new TextEncoder().encode('bravo'))
    expect(a).not.toBe(b)
  })

  it('handles single-byte input', () => {
    const result = crc32(new Uint8Array([0x00]))
    expect(result).toBe(0xd202ef8d)
  })

  it('returns an unsigned 32-bit integer', () => {
    const input = new TextEncoder().encode('test data for unsigned check')
    const result = crc32(input)
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThanOrEqual(0xffffffff)
  })

  it('handles binary data with all byte values', () => {
    const allBytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
      allBytes[i] = i
    }
    const result = crc32(allBytes)
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThanOrEqual(0xffffffff)
    expect(result).toBe(crc32(allBytes))
  })
})
