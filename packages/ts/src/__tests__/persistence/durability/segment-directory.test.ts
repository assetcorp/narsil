import { describe, expect, it } from 'vitest'
import { NarsilError } from '../../../errors'
import { chooseColdGlobalDepth } from '../../../persistence/durability/segment/bulk-load'
import {
  type BucketDirectory,
  doubleDirectory,
  identityDirectory,
  log2OfPowerOfTwo,
  splitBucket,
} from '../../../persistence/durability/segment/directory'

describe('bucket directory primitives', () => {
  it('builds an identity directory of the requested depth', () => {
    const directory = identityDirectory(3)
    expect(directory.globalDepth).toBe(3)
    expect(directory.slots).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('doubles the directory by concatenating the slot table with itself', () => {
    const directory = identityDirectory(1)
    doubleDirectory(directory)
    expect(directory.globalDepth).toBe(2)
    expect(directory.slots).toEqual([0, 1, 0, 1])
  })

  it('computes the depth of a power of two', () => {
    expect(log2OfPowerOfTwo(1)).toBe(0)
    expect(log2OfPowerOfTwo(8)).toBe(3)
    expect(log2OfPowerOfTwo(256)).toBe(8)
  })

  it('splits a bucket by one more bit and moves only the high-bit slots', () => {
    const directory: BucketDirectory = { globalDepth: 1, slots: [0, 0] }
    const localDepthByBucket = new Map<number, number>([[0, 0]])

    const result = splitBucket(directory, localDepthByBucket, 0)

    expect(directory.globalDepth).toBe(1)
    expect(directory.slots).toEqual([0, result.highBucketId])
    expect(localDepthByBucket.get(0)).toBe(1)
    expect(localDepthByBucket.get(result.highBucketId)).toBe(1)
  })

  it('doubles the directory before splitting when local depth equals global depth', () => {
    const directory: BucketDirectory = { globalDepth: 1, slots: [0, 1] }
    const localDepthByBucket = new Map<number, number>([
      [0, 1],
      [1, 1],
    ])

    const result = splitBucket(directory, localDepthByBucket, 0)

    expect(directory.globalDepth).toBe(2)
    expect(directory.slots.length).toBe(4)
    expect(localDepthByBucket.get(0)).toBe(2)
    expect(localDepthByBucket.get(result.highBucketId)).toBe(2)
    const slotsForBucketZero = directory.slots.filter(b => b === 0).length
    const slotsForHighBucket = directory.slots.filter(b => b === result.highBucketId).length
    expect(slotsForBucketZero).toBe(1)
    expect(slotsForHighBucket).toBe(1)
  })

  it('throws when splitting a bucket with no recorded depth', () => {
    const directory: BucketDirectory = { globalDepth: 0, slots: [0] }
    expect(() => splitBucket(directory, new Map(), 0)).toThrow(NarsilError)
  })
})

describe('cold checkpoint depth sizing', () => {
  it('keeps a single bucket when the index fits the target', () => {
    expect(chooseColdGlobalDepth(0, 65_536)).toBe(0)
    expect(chooseColdGlobalDepth(65_536, 65_536)).toBe(0)
  })

  it('rounds the bucket count up to the next power of two as data exceeds the target', () => {
    expect(chooseColdGlobalDepth(65_537, 65_536)).toBe(1)
    expect(chooseColdGlobalDepth(4 * 65_536, 65_536)).toBe(2)
    expect(chooseColdGlobalDepth(5 * 65_536, 65_536)).toBe(3)
  })

  it('clamps the depth at the supported maximum for an oversized index', () => {
    expect(chooseColdGlobalDepth(Number.MAX_SAFE_INTEGER, 1)).toBe(16)
  })
})
