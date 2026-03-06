import { describe, expect, it } from 'vitest'
import { fnv1a } from '../../core/hash'

describe('fnv1a', () => {
  it('returns the FNV offset basis for an empty string', () => {
    expect(fnv1a('')).toBe(0x811c9dc5)
  })

  it('returns a 32-bit unsigned integer', () => {
    const hash = fnv1a('test')
    expect(hash).toBeGreaterThanOrEqual(0)
    expect(hash).toBeLessThanOrEqual(0xffffffff)
  })

  it('is deterministic for the same input', () => {
    const a = fnv1a('hello world')
    const b = fnv1a('hello world')
    expect(a).toBe(b)
  })

  it('produces different hashes for different inputs', () => {
    const a = fnv1a('alpha')
    const b = fnv1a('bravo')
    const c = fnv1a('charlie')
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
    expect(a).not.toBe(c)
  })

  it('matches known FNV-1a 32-bit test vectors', () => {
    expect(fnv1a('a')).toBe(0xe40c292c)
    expect(fnv1a('foobar')).toBe(0xbf9cf968)
  })

  it('handles unicode strings via UTF-8 encoding', () => {
    const hash = fnv1a('\u00e9')
    expect(hash).toBeGreaterThanOrEqual(0)
    expect(hash).toBeLessThanOrEqual(0xffffffff)
    expect(hash).not.toBe(fnv1a('e'))
  })

  it('distributes across buckets for sequential keys', () => {
    const bucketCount = 8
    const buckets = new Array(bucketCount).fill(0)
    for (let i = 0; i < 1000; i++) {
      const hash = fnv1a(`doc-${i}`)
      buckets[hash % bucketCount]++
    }
    for (let i = 0; i < bucketCount; i++) {
      expect(buckets[i]).toBeGreaterThan(50)
      expect(buckets[i]).toBeLessThan(200)
    }
  })

  it('handles long strings', () => {
    const long = 'x'.repeat(10000)
    const hash = fnv1a(long)
    expect(hash).toBeGreaterThanOrEqual(0)
    expect(hash).toBeLessThanOrEqual(0xffffffff)
  })
})
