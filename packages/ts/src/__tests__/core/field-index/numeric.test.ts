import { beforeEach, describe, expect, it } from 'vitest'
import { createNumericIndex, type NumericFieldIndex } from '../../../core/field-index'

describe('NumericFieldIndex', () => {
  let idx: NumericFieldIndex

  beforeEach(() => {
    idx = createNumericIndex()
  })

  describe('insert and count', () => {
    it('inserts entries and tracks count', () => {
      idx.insert(0, 10)
      idx.insert(1, 20)
      idx.insert(2, 15)
      expect(idx.count()).toBe(3)
    })

    it('maintains sorted order after inserts', () => {
      idx.insert(0, 30)
      idx.insert(1, 10)
      idx.insert(2, 20)
      const serialized = idx.serialize()
      const values = serialized.map(e => e.value)
      expect(values).toEqual([10, 20, 30])
    })

    it('handles duplicate values from different documents', () => {
      idx.insert(0, 10)
      idx.insert(1, 10)
      expect(idx.count()).toBe(2)
      expect(idx.queryEq(10).size).toBe(2)
    })
  })

  describe('remove', () => {
    it('removes a specific docId at a given value', () => {
      idx.insert(0, 10)
      idx.insert(1, 10)
      idx.remove(0, 10)
      expect(idx.count()).toBe(1)
      expect(idx.queryEq(10)).toEqual(new Set([1]))
    })

    it('does nothing when the value does not exist', () => {
      idx.insert(0, 10)
      idx.remove(0, 999)
      expect(idx.count()).toBe(1)
    })

    it('does nothing when the docId does not match', () => {
      idx.insert(0, 10)
      idx.remove(99, 10)
      expect(idx.count()).toBe(1)
    })
  })

  describe('queryEq', () => {
    it('returns docIds matching an exact value', () => {
      idx.insert(0, 10)
      idx.insert(1, 20)
      idx.insert(2, 10)
      expect(idx.queryEq(10)).toEqual(new Set([0, 2]))
    })

    it('returns empty set for non-existent value', () => {
      idx.insert(0, 10)
      expect(idx.queryEq(999).size).toBe(0)
    })
  })

  describe('queryNe', () => {
    it('returns all docIds except those matching the value', () => {
      idx.insert(0, 10)
      idx.insert(1, 20)
      idx.insert(2, 10)
      expect(idx.queryNe(10)).toEqual(new Set([1]))
    })
  })

  describe('queryGt', () => {
    it('returns docIds with values strictly greater than threshold', () => {
      idx.insert(0, 5)
      idx.insert(1, 10)
      idx.insert(2, 15)
      idx.insert(3, 20)
      expect(idx.queryGt(10)).toEqual(new Set([2, 3]))
    })

    it('returns empty set when no values exceed the threshold', () => {
      idx.insert(0, 5)
      expect(idx.queryGt(100).size).toBe(0)
    })
  })

  describe('queryGte', () => {
    it('returns docIds with values greater than or equal to threshold', () => {
      idx.insert(0, 5)
      idx.insert(1, 10)
      idx.insert(2, 15)
      expect(idx.queryGte(10)).toEqual(new Set([1, 2]))
    })
  })

  describe('queryLt', () => {
    it('returns docIds with values strictly less than threshold', () => {
      idx.insert(0, 5)
      idx.insert(1, 10)
      idx.insert(2, 15)
      expect(idx.queryLt(10)).toEqual(new Set([0]))
    })

    it('returns empty set when no values are below the threshold', () => {
      idx.insert(0, 50)
      expect(idx.queryLt(1).size).toBe(0)
    })
  })

  describe('queryLte', () => {
    it('returns docIds with values less than or equal to threshold', () => {
      idx.insert(0, 5)
      idx.insert(1, 10)
      idx.insert(2, 15)
      expect(idx.queryLte(10)).toEqual(new Set([0, 1]))
    })
  })

  describe('queryBetween', () => {
    it('returns docIds within an inclusive range', () => {
      idx.insert(0, 5)
      idx.insert(1, 10)
      idx.insert(2, 15)
      idx.insert(3, 20)
      idx.insert(4, 25)
      expect(idx.queryBetween(10, 20)).toEqual(new Set([1, 2, 3]))
    })

    it('returns empty set when range has no matches', () => {
      idx.insert(0, 5)
      idx.insert(1, 25)
      expect(idx.queryBetween(10, 20).size).toBe(0)
    })

    it('handles a single-point range', () => {
      idx.insert(0, 10)
      idx.insert(1, 10)
      expect(idx.queryBetween(10, 10)).toEqual(new Set([0, 1]))
    })
  })

  describe('getAllDocIds', () => {
    it('returns unique docIds across all entries', () => {
      idx.insert(0, 10)
      idx.insert(0, 20)
      idx.insert(1, 30)
      const all = idx.getAllDocIds()
      expect(all).toEqual(new Set([0, 1]))
    })

    it('returns empty set for an empty index', () => {
      expect(idx.getAllDocIds().size).toBe(0)
    })
  })

  describe('clear', () => {
    it('removes all entries', () => {
      idx.insert(0, 10)
      idx.insert(1, 20)
      idx.clear()
      expect(idx.count()).toBe(0)
      expect(idx.queryEq(10).size).toBe(0)
    })
  })

  describe('serialize and deserialize', () => {
    it('roundtrips through serialization', () => {
      idx.insert(0, 10)
      idx.insert(1, 20)
      idx.insert(2, 15)

      const data = idx.serialize()
      const restored = createNumericIndex()
      restored.deserialize(data)

      expect(restored.count()).toBe(3)
      expect(restored.queryEq(10)).toEqual(new Set([0]))
      expect(restored.queryBetween(10, 20)).toEqual(new Set([0, 1, 2]))
    })

    it('serialized data is a sorted array of entries', () => {
      idx.insert(0, 30)
      idx.insert(1, 10)
      const data = idx.serialize()
      expect(data[0]).toEqual({ value: 10, docId: 1 })
      expect(data[1]).toEqual({ value: 30, docId: 0 })
    })

    it('deserialize replaces existing state', () => {
      idx.insert(0, 999)
      idx.deserialize([{ value: 1, docId: 1 }])
      expect(idx.queryEq(999).size).toBe(0)
      expect(idx.queryEq(1)).toEqual(new Set([1]))
    })
  })

  describe('edge cases', () => {
    it('handles negative values', () => {
      idx.insert(0, -10)
      idx.insert(1, -5)
      idx.insert(2, 0)
      expect(idx.queryLt(0)).toEqual(new Set([0, 1]))
      expect(idx.queryGte(-5)).toEqual(new Set([1, 2]))
    })

    it('handles floating-point values', () => {
      idx.insert(0, 1.5)
      idx.insert(1, 2.7)
      idx.insert(2, 1.5)
      expect(idx.queryEq(1.5)).toEqual(new Set([0, 2]))
      expect(idx.queryBetween(1.0, 2.0)).toEqual(new Set([0, 2]))
    })

    it('operations on an empty index return empty results', () => {
      expect(idx.queryEq(0).size).toBe(0)
      expect(idx.queryGt(0).size).toBe(0)
      expect(idx.queryLt(0).size).toBe(0)
      expect(idx.queryBetween(0, 100).size).toBe(0)
    })
  })
})
