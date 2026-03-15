import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createPartitionRouter } from '../../partitioning/router'

describe('PartitionRouter', () => {
  const router = createPartitionRouter()

  describe('route', () => {
    it('returns the same partition for the same docId every time', () => {
      const pid1 = router.route('user-42', 8)
      const pid2 = router.route('user-42', 8)
      const pid3 = router.route('user-42', 8)
      expect(pid1).toBe(pid2)
      expect(pid2).toBe(pid3)
    })

    it('returns 0 when partitionCount is 1', () => {
      expect(router.route('any-doc', 1)).toBe(0)
      expect(router.route('another-doc', 1)).toBe(0)
      expect(router.route('third-doc', 1)).toBe(0)
    })

    it('distributes 10000 random IDs across 4 partitions within 15-35% each', () => {
      const counts = [0, 0, 0, 0]
      for (let i = 0; i < 10_000; i++) {
        const pid = router.route(`doc-${i}-${Math.random().toString(36).slice(2)}`, 4)
        counts[pid]++
      }
      for (let p = 0; p < 4; p++) {
        const pct = counts[p] / 10_000
        expect(pct).toBeGreaterThanOrEqual(0.15)
        expect(pct).toBeLessThanOrEqual(0.35)
      }
    })

    it('returns values in range [0, partitionCount)', () => {
      for (let i = 0; i < 100; i++) {
        const pid = router.route(`id-${i}`, 7)
        expect(pid).toBeGreaterThanOrEqual(0)
        expect(pid).toBeLessThan(7)
      }
    })

    it('throws INDEX_NOT_FOUND when partitionCount is 0', () => {
      expect(() => router.route('doc1', 0)).toThrow(NarsilError)
      try {
        router.route('doc1', 0)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.INDEX_NOT_FOUND)
      }
    })

    it('throws INDEX_NOT_FOUND when partitionCount is negative', () => {
      expect(() => router.route('doc1', -3)).toThrow(NarsilError)
      try {
        router.route('doc1', -3)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.INDEX_NOT_FOUND)
      }
    })
  })

  describe('routeBatch', () => {
    it('groups document IDs by their routed partition', () => {
      const docIds = ['a', 'b', 'c', 'd', 'e']
      const groups = router.routeBatch(docIds, 4)

      let totalDocs = 0
      for (const [, ids] of groups) {
        totalDocs += ids.length
      }
      expect(totalDocs).toBe(docIds.length)

      for (const [pid, ids] of groups) {
        for (const id of ids) {
          expect(router.route(id, 4)).toBe(pid)
        }
      }
    })

    it('returns an empty map for an empty input array', () => {
      const groups = router.routeBatch([], 4)
      expect(groups.size).toBe(0)
    })

    it('places all IDs into partition 0 when partitionCount is 1', () => {
      const docIds = ['x', 'y', 'z']
      const groups = router.routeBatch(docIds, 1)
      expect(groups.size).toBe(1)
      expect(groups.get(0)).toEqual(docIds)
    })
  })
})
