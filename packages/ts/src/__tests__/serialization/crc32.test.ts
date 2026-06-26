import { describe, expect, it } from 'vitest'
import { computeOffThreadChecksum } from '../../serialization/checksum-dispatch'
import { crc32, crc32Final, crc32Init, crc32Update } from '../../serialization/crc32'

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

describe('crc32 incremental', () => {
  function makeData(size: number): Uint8Array {
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) {
      data[i] = (i * 31 + 7) & 0xff
    }
    return data
  }

  it('matches the whole-buffer checksum regardless of where chunks split', () => {
    const data = makeData(10_000)
    const reference = crc32(data)
    for (const chunkSize of [1, 7, 256, 1024, 9_999, 10_000]) {
      let state = crc32Init()
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        state = crc32Update(state, data.subarray(offset, Math.min(offset + chunkSize, data.length)))
      }
      expect(crc32Final(state)).toBe(reference)
    }
  })

  it('matches for empty input', () => {
    expect(crc32Final(crc32Init())).toBe(crc32(new Uint8Array(0)))
  })
})

describe('computeOffThreadChecksum', () => {
  it('matches the synchronous checksum for payloads of varied sizes', async () => {
    for (const size of [0, 1, 4095, 4096, 4097, 1_000_000]) {
      const data = new Uint8Array(size)
      for (let i = 0; i < size; i++) {
        data[i] = (i * 13 + 5) & 0xff
      }
      expect(await computeOffThreadChecksum(data)).toBe(crc32(data))
    }
  })

  it('does not mutate or detach the payload it is given', async () => {
    const data = new Uint8Array([10, 20, 30, 40, 50])
    await computeOffThreadChecksum(data)
    expect([...data]).toEqual([10, 20, 30, 40, 50])
  })
})
