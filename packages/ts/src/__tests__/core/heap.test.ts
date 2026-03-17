import { describe, expect, it } from 'vitest'
import { createBoundedMaxHeap, createMaxHeap, createMinHeap } from '../../core/heap'

describe('BinaryHeap', () => {
  describe('createMinHeap', () => {
    it('pops elements in ascending order', () => {
      const heap = createMinHeap<number>((a, b) => a - b)
      heap.push(5)
      heap.push(1)
      heap.push(3)
      heap.push(2)
      heap.push(4)

      const result: number[] = []
      while (heap.size > 0) {
        const val = heap.pop()
        if (val !== undefined) result.push(val)
      }

      expect(result).toEqual([1, 2, 3, 4, 5])
    })

    it('peek returns the smallest element without removing it', () => {
      const heap = createMinHeap<number>((a, b) => a - b)
      heap.push(10)
      heap.push(3)
      heap.push(7)

      expect(heap.peek()).toBe(3)
      expect(heap.size).toBe(3)
    })

    it('returns undefined from pop and peek on empty heap', () => {
      const heap = createMinHeap<number>((a, b) => a - b)
      expect(heap.pop()).toBeUndefined()
      expect(heap.peek()).toBeUndefined()
    })

    it('handles duplicate values', () => {
      const heap = createMinHeap<number>((a, b) => a - b)
      heap.push(3)
      heap.push(3)
      heap.push(1)
      heap.push(3)

      expect(heap.pop()).toBe(1)
      expect(heap.pop()).toBe(3)
      expect(heap.pop()).toBe(3)
      expect(heap.pop()).toBe(3)
    })

    it('toSortedArray returns sorted copy without mutating the heap', () => {
      const heap = createMinHeap<number>((a, b) => a - b)
      heap.push(5)
      heap.push(1)
      heap.push(3)

      const sorted = heap.toSortedArray()
      expect(sorted).toEqual([1, 3, 5])
      expect(heap.size).toBe(3)
    })

    it('works with object comparators', () => {
      interface Item {
        priority: number
        name: string
      }
      const heap = createMinHeap<Item>((a, b) => a.priority - b.priority)
      heap.push({ priority: 3, name: 'c' })
      heap.push({ priority: 1, name: 'a' })
      heap.push({ priority: 2, name: 'b' })

      expect(heap.pop()?.name).toBe('a')
      expect(heap.pop()?.name).toBe('b')
      expect(heap.pop()?.name).toBe('c')
    })
  })

  describe('createMaxHeap', () => {
    it('pops elements in descending order', () => {
      const heap = createMaxHeap<number>((a, b) => a - b)
      heap.push(1)
      heap.push(5)
      heap.push(3)
      heap.push(2)
      heap.push(4)

      const result: number[] = []
      while (heap.size > 0) {
        const val = heap.pop()
        if (val !== undefined) result.push(val)
      }

      expect(result).toEqual([5, 4, 3, 2, 1])
    })

    it('peek returns the largest element', () => {
      const heap = createMaxHeap<number>((a, b) => a - b)
      heap.push(2)
      heap.push(8)
      heap.push(5)

      expect(heap.peek()).toBe(8)
    })
  })

  describe('createBoundedMaxHeap', () => {
    it('keeps only the smallest N elements', () => {
      const heap = createBoundedMaxHeap<number>((a, b) => a - b, 3)
      heap.push(10)
      heap.push(1)
      heap.push(5)
      heap.push(3)
      heap.push(8)
      heap.push(2)

      expect(heap.size).toBe(3)

      const drained: number[] = []
      while (heap.size > 0) {
        const val = heap.pop()
        if (val !== undefined) drained.push(val)
      }
      drained.sort((a, b) => a - b)
      expect(drained).toEqual([1, 2, 3])
    })

    it('peek returns the largest element in the bounded set (eviction candidate)', () => {
      const heap = createBoundedMaxHeap<number>((a, b) => a - b, 3)
      heap.push(5)
      heap.push(1)
      heap.push(3)

      expect(heap.peek()).toBe(5)

      heap.push(2)
      expect(heap.peek()).toBe(3)
      expect(heap.size).toBe(3)
    })

    it('does not add elements larger than the current max when full', () => {
      const heap = createBoundedMaxHeap<number>((a, b) => a - b, 2)
      heap.push(1)
      heap.push(3)
      heap.push(5)
      heap.push(10)

      expect(heap.size).toBe(2)
      const drained: number[] = []
      while (heap.size > 0) {
        const val = heap.pop()
        if (val !== undefined) drained.push(val)
      }
      drained.sort((a, b) => a - b)
      expect(drained).toEqual([1, 3])
    })

    it('handles capacity of 1', () => {
      const heap = createBoundedMaxHeap<number>((a, b) => a - b, 1)
      heap.push(5)
      heap.push(3)
      heap.push(1)

      expect(heap.size).toBe(1)
      expect(heap.peek()).toBe(1)
    })

    it('works with distance-like objects', () => {
      interface Pair {
        id: string
        distance: number
      }
      const heap = createBoundedMaxHeap<Pair>((a, b) => a.distance - b.distance, 3)

      heap.push({ id: 'a', distance: 10 })
      heap.push({ id: 'b', distance: 2 })
      heap.push({ id: 'c', distance: 5 })
      heap.push({ id: 'd', distance: 1 })
      heap.push({ id: 'e', distance: 8 })

      expect(heap.size).toBe(3)
      const drained: Pair[] = []
      while (heap.size > 0) {
        const val = heap.pop()
        if (val !== undefined) drained.push(val)
      }
      drained.sort((a, b) => a.distance - b.distance)
      const ids = drained.map(p => p.id)
      expect(ids).toEqual(['d', 'b', 'c'])
    })
  })

  describe('stress test', () => {
    it('maintains correct ordering with many insertions', () => {
      const heap = createMinHeap<number>((a, b) => a - b)
      const values: number[] = []

      for (let i = 0; i < 1000; i++) {
        const v = Math.random() * 10000
        values.push(v)
        heap.push(v)
      }

      values.sort((a, b) => a - b)

      for (let i = 0; i < 1000; i++) {
        const popped = heap.pop()
        expect(popped).toBeCloseTo(values[i], 10)
      }
    })
  })
})
