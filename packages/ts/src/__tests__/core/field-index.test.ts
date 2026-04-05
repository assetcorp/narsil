import { beforeEach, describe, expect, it } from 'vitest'
import {
  type BooleanFieldIndex,
  createBooleanIndex,
  createEnumIndex,
  createNumericIndex,
  type EnumFieldIndex,
  type NumericFieldIndex,
} from '../../core/field-index'

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

describe('BooleanFieldIndex', () => {
  let idx: BooleanFieldIndex

  beforeEach(() => {
    idx = createBooleanIndex()
  })

  describe('insert and count', () => {
    it('inserts documents into true and false sets', () => {
      idx.insert(0, true)
      idx.insert(1, false)
      idx.insert(2, true)
      expect(idx.count()).toBe(3)
    })
  })

  describe('remove', () => {
    it('removes a document from the correct set', () => {
      idx.insert(0, true)
      idx.insert(1, false)
      idx.remove(0, true)
      expect(idx.count()).toBe(1)
      expect(idx.queryEq(true).size).toBe(0)
    })

    it('does not affect the opposite set', () => {
      idx.insert(0, true)
      idx.insert(1, false)
      idx.remove(0, true)
      expect(idx.queryEq(false)).toEqual(new Set([1]))
    })
  })

  describe('queryEq', () => {
    it('returns all true documents when querying for true', () => {
      idx.insert(0, true)
      idx.insert(1, false)
      idx.insert(2, true)
      expect(idx.queryEq(true)).toEqual(new Set([0, 2]))
    })

    it('returns all false documents when querying for false', () => {
      idx.insert(0, true)
      idx.insert(1, false)
      expect(idx.queryEq(false)).toEqual(new Set([1]))
    })

    it('returns a copy, not a reference', () => {
      idx.insert(0, true)
      const result = idx.queryEq(true)
      result.add(999)
      expect(idx.queryEq(true).has(999)).toBe(false)
    })
  })

  describe('queryNe', () => {
    it('queryNe(true) returns false docs', () => {
      idx.insert(0, true)
      idx.insert(1, false)
      expect(idx.queryNe(true)).toEqual(new Set([1]))
    })

    it('queryNe(false) returns true docs', () => {
      idx.insert(0, true)
      idx.insert(1, false)
      expect(idx.queryNe(false)).toEqual(new Set([0]))
    })
  })

  describe('getAllDocIds', () => {
    it('returns all documents from both sets', () => {
      idx.insert(0, true)
      idx.insert(1, false)
      idx.insert(2, true)
      expect(idx.getAllDocIds()).toEqual(new Set([0, 1, 2]))
    })
  })

  describe('clear', () => {
    it('empties both sets', () => {
      idx.insert(0, true)
      idx.insert(1, false)
      idx.clear()
      expect(idx.count()).toBe(0)
      expect(idx.queryEq(true).size).toBe(0)
      expect(idx.queryEq(false).size).toBe(0)
    })
  })

  describe('serialize and deserialize', () => {
    it('roundtrips through serialization', () => {
      idx.insert(0, true)
      idx.insert(1, false)
      idx.insert(2, true)

      const data = idx.serialize()
      const restored = createBooleanIndex()
      restored.deserialize(data)

      expect(restored.queryEq(true)).toEqual(new Set([0, 2]))
      expect(restored.queryEq(false)).toEqual(new Set([1]))
    })

    it('serializes to arrays of docIds', () => {
      idx.insert(0, true)
      idx.insert(1, false)
      const data = idx.serialize()
      expect(data.trueDocs).toContain(0)
      expect(data.falseDocs).toContain(1)
    })

    it('deserialize replaces existing state', () => {
      idx.insert(0, true)
      idx.deserialize({ trueDocs: [1], falseDocs: [2] })
      expect(idx.queryEq(true)).toEqual(new Set([1]))
      expect(idx.queryEq(false)).toEqual(new Set([2]))
      expect(idx.count()).toBe(2)
    })
  })
})

describe('EnumFieldIndex', () => {
  let idx: EnumFieldIndex

  beforeEach(() => {
    idx = createEnumIndex()
  })

  describe('insert and count', () => {
    it('inserts documents under enum values', () => {
      idx.insert(0, 'red')
      idx.insert(1, 'blue')
      idx.insert(2, 'red')
      expect(idx.count()).toBe(3)
    })
  })

  describe('remove', () => {
    it('removes a docId from a specific value', () => {
      idx.insert(0, 'red')
      idx.insert(1, 'red')
      idx.remove(0, 'red')
      expect(idx.queryEq('red')).toEqual(new Set([1]))
    })

    it('cleans up the value key when the last doc is removed', () => {
      idx.insert(0, 'rare')
      idx.remove(0, 'rare')
      expect(idx.queryEq('rare').size).toBe(0)
      expect(idx.count()).toBe(0)
    })

    it('does nothing for a non-existent value', () => {
      idx.insert(0, 'red')
      idx.remove(0, 'green')
      expect(idx.count()).toBe(1)
    })
  })

  describe('queryEq', () => {
    it('returns all docIds for a given enum value', () => {
      idx.insert(0, 'red')
      idx.insert(1, 'blue')
      idx.insert(2, 'red')
      expect(idx.queryEq('red')).toEqual(new Set([0, 2]))
    })

    it('returns empty set for non-existent value', () => {
      expect(idx.queryEq('missing').size).toBe(0)
    })

    it('returns a copy, not a reference to internal state', () => {
      idx.insert(0, 'red')
      const result = idx.queryEq('red')
      result.add(999)
      expect(idx.queryEq('red').has(999)).toBe(false)
    })
  })

  describe('queryNe', () => {
    it('returns all docIds NOT matching the given value', () => {
      idx.insert(0, 'red')
      idx.insert(1, 'blue')
      idx.insert(2, 'green')
      expect(idx.queryNe('red')).toEqual(new Set([1, 2]))
    })

    it('returns all docIds when the excluded value has no entries', () => {
      idx.insert(0, 'red')
      idx.insert(1, 'blue')
      expect(idx.queryNe('missing')).toEqual(new Set([0, 1]))
    })
  })

  describe('queryIn', () => {
    it('returns the union of docIds across multiple values', () => {
      idx.insert(0, 'red')
      idx.insert(1, 'blue')
      idx.insert(2, 'green')
      expect(idx.queryIn(['red', 'green'])).toEqual(new Set([0, 2]))
    })

    it('handles values that do not exist in the index', () => {
      idx.insert(0, 'red')
      expect(idx.queryIn(['red', 'missing'])).toEqual(new Set([0]))
    })

    it('returns empty set for an empty values list', () => {
      idx.insert(0, 'red')
      expect(idx.queryIn([]).size).toBe(0)
    })
  })

  describe('queryNin', () => {
    it('returns docIds NOT matching any of the given values', () => {
      idx.insert(0, 'red')
      idx.insert(1, 'blue')
      idx.insert(2, 'green')
      idx.insert(3, 'red')
      expect(idx.queryNin(['red', 'blue'])).toEqual(new Set([2]))
    })

    it('returns all docIds when excluding non-existent values', () => {
      idx.insert(0, 'red')
      idx.insert(1, 'blue')
      expect(idx.queryNin(['missing'])).toEqual(new Set([0, 1]))
    })
  })

  describe('getAllDocIds', () => {
    it('returns unique docIds across all values', () => {
      idx.insert(0, 'red')
      idx.insert(0, 'blue')
      idx.insert(1, 'green')
      expect(idx.getAllDocIds()).toEqual(new Set([0, 1]))
    })

    it('returns empty set for an empty index', () => {
      expect(idx.getAllDocIds().size).toBe(0)
    })
  })

  describe('clear', () => {
    it('removes all entries', () => {
      idx.insert(0, 'red')
      idx.insert(1, 'blue')
      idx.clear()
      expect(idx.count()).toBe(0)
      expect(idx.queryEq('red').size).toBe(0)
    })
  })

  describe('serialize and deserialize', () => {
    it('roundtrips through serialization', () => {
      idx.insert(0, 'red')
      idx.insert(1, 'blue')
      idx.insert(2, 'red')

      const data = idx.serialize()
      const restored = createEnumIndex()
      restored.deserialize(data)

      expect(restored.queryEq('red')).toEqual(new Set([0, 2]))
      expect(restored.queryEq('blue')).toEqual(new Set([1]))
    })

    it('serializes to a value -> docId[] mapping', () => {
      idx.insert(0, 'red')
      idx.insert(1, 'red')
      const data = idx.serialize()
      expect(data.red).toContain(0)
      expect(data.red).toContain(1)
    })

    it('deserialize replaces existing state', () => {
      idx.insert(0, 'stale')
      idx.deserialize({ fresh: [1, 2] })
      expect(idx.queryEq('stale').size).toBe(0)
      expect(idx.queryEq('fresh')).toEqual(new Set([1, 2]))
    })
  })
})
