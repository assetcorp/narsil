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
      idx.insert('doc1', 10)
      idx.insert('doc2', 20)
      idx.insert('doc3', 15)
      expect(idx.count()).toBe(3)
    })

    it('maintains sorted order after inserts', () => {
      idx.insert('doc1', 30)
      idx.insert('doc2', 10)
      idx.insert('doc3', 20)
      const serialized = idx.serialize()
      const values = serialized.map(e => e.value)
      expect(values).toEqual([10, 20, 30])
    })

    it('handles duplicate values from different documents', () => {
      idx.insert('doc1', 10)
      idx.insert('doc2', 10)
      expect(idx.count()).toBe(2)
      expect(idx.queryEq(10).size).toBe(2)
    })
  })

  describe('remove', () => {
    it('removes a specific docId at a given value', () => {
      idx.insert('doc1', 10)
      idx.insert('doc2', 10)
      idx.remove('doc1', 10)
      expect(idx.count()).toBe(1)
      expect(idx.queryEq(10)).toEqual(new Set(['doc2']))
    })

    it('does nothing when the value does not exist', () => {
      idx.insert('doc1', 10)
      idx.remove('doc1', 999)
      expect(idx.count()).toBe(1)
    })

    it('does nothing when the docId does not match', () => {
      idx.insert('doc1', 10)
      idx.remove('doc99', 10)
      expect(idx.count()).toBe(1)
    })
  })

  describe('queryEq', () => {
    it('returns docIds matching an exact value', () => {
      idx.insert('doc1', 10)
      idx.insert('doc2', 20)
      idx.insert('doc3', 10)
      expect(idx.queryEq(10)).toEqual(new Set(['doc1', 'doc3']))
    })

    it('returns empty set for non-existent value', () => {
      idx.insert('doc1', 10)
      expect(idx.queryEq(999).size).toBe(0)
    })
  })

  describe('queryNe', () => {
    it('returns all docIds except those matching the value', () => {
      idx.insert('doc1', 10)
      idx.insert('doc2', 20)
      idx.insert('doc3', 10)
      expect(idx.queryNe(10)).toEqual(new Set(['doc2']))
    })
  })

  describe('queryGt', () => {
    it('returns docIds with values strictly greater than threshold', () => {
      idx.insert('doc1', 5)
      idx.insert('doc2', 10)
      idx.insert('doc3', 15)
      idx.insert('doc4', 20)
      expect(idx.queryGt(10)).toEqual(new Set(['doc3', 'doc4']))
    })

    it('returns empty set when no values exceed the threshold', () => {
      idx.insert('doc1', 5)
      expect(idx.queryGt(100).size).toBe(0)
    })
  })

  describe('queryGte', () => {
    it('returns docIds with values greater than or equal to threshold', () => {
      idx.insert('doc1', 5)
      idx.insert('doc2', 10)
      idx.insert('doc3', 15)
      expect(idx.queryGte(10)).toEqual(new Set(['doc2', 'doc3']))
    })
  })

  describe('queryLt', () => {
    it('returns docIds with values strictly less than threshold', () => {
      idx.insert('doc1', 5)
      idx.insert('doc2', 10)
      idx.insert('doc3', 15)
      expect(idx.queryLt(10)).toEqual(new Set(['doc1']))
    })

    it('returns empty set when no values are below the threshold', () => {
      idx.insert('doc1', 50)
      expect(idx.queryLt(1).size).toBe(0)
    })
  })

  describe('queryLte', () => {
    it('returns docIds with values less than or equal to threshold', () => {
      idx.insert('doc1', 5)
      idx.insert('doc2', 10)
      idx.insert('doc3', 15)
      expect(idx.queryLte(10)).toEqual(new Set(['doc1', 'doc2']))
    })
  })

  describe('queryBetween', () => {
    it('returns docIds within an inclusive range', () => {
      idx.insert('doc1', 5)
      idx.insert('doc2', 10)
      idx.insert('doc3', 15)
      idx.insert('doc4', 20)
      idx.insert('doc5', 25)
      expect(idx.queryBetween(10, 20)).toEqual(new Set(['doc2', 'doc3', 'doc4']))
    })

    it('returns empty set when range has no matches', () => {
      idx.insert('doc1', 5)
      idx.insert('doc2', 25)
      expect(idx.queryBetween(10, 20).size).toBe(0)
    })

    it('handles a single-point range', () => {
      idx.insert('doc1', 10)
      idx.insert('doc2', 10)
      expect(idx.queryBetween(10, 10)).toEqual(new Set(['doc1', 'doc2']))
    })
  })

  describe('getAllDocIds', () => {
    it('returns unique docIds across all entries', () => {
      idx.insert('doc1', 10)
      idx.insert('doc1', 20)
      idx.insert('doc2', 30)
      const all = idx.getAllDocIds()
      expect(all).toEqual(new Set(['doc1', 'doc2']))
    })

    it('returns empty set for an empty index', () => {
      expect(idx.getAllDocIds().size).toBe(0)
    })
  })

  describe('clear', () => {
    it('removes all entries', () => {
      idx.insert('doc1', 10)
      idx.insert('doc2', 20)
      idx.clear()
      expect(idx.count()).toBe(0)
      expect(idx.queryEq(10).size).toBe(0)
    })
  })

  describe('serialize and deserialize', () => {
    it('roundtrips through serialization', () => {
      idx.insert('doc1', 10)
      idx.insert('doc2', 20)
      idx.insert('doc3', 15)

      const data = idx.serialize()
      const restored = createNumericIndex()
      restored.deserialize(data)

      expect(restored.count()).toBe(3)
      expect(restored.queryEq(10)).toEqual(new Set(['doc1']))
      expect(restored.queryBetween(10, 20)).toEqual(new Set(['doc1', 'doc2', 'doc3']))
    })

    it('serialized data is a sorted array of entries', () => {
      idx.insert('doc1', 30)
      idx.insert('doc2', 10)
      const data = idx.serialize()
      expect(data[0]).toEqual({ value: 10, docId: 'doc2' })
      expect(data[1]).toEqual({ value: 30, docId: 'doc1' })
    })

    it('deserialize replaces existing state', () => {
      idx.insert('old', 999)
      idx.deserialize([{ value: 1, docId: 'new' }])
      expect(idx.queryEq(999).size).toBe(0)
      expect(idx.queryEq(1)).toEqual(new Set(['new']))
    })
  })

  describe('edge cases', () => {
    it('handles negative values', () => {
      idx.insert('doc1', -10)
      idx.insert('doc2', -5)
      idx.insert('doc3', 0)
      expect(idx.queryLt(0)).toEqual(new Set(['doc1', 'doc2']))
      expect(idx.queryGte(-5)).toEqual(new Set(['doc2', 'doc3']))
    })

    it('handles floating-point values', () => {
      idx.insert('doc1', 1.5)
      idx.insert('doc2', 2.7)
      idx.insert('doc3', 1.5)
      expect(idx.queryEq(1.5)).toEqual(new Set(['doc1', 'doc3']))
      expect(idx.queryBetween(1.0, 2.0)).toEqual(new Set(['doc1', 'doc3']))
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
      idx.insert('doc1', true)
      idx.insert('doc2', false)
      idx.insert('doc3', true)
      expect(idx.count()).toBe(3)
    })
  })

  describe('remove', () => {
    it('removes a document from the correct set', () => {
      idx.insert('doc1', true)
      idx.insert('doc2', false)
      idx.remove('doc1', true)
      expect(idx.count()).toBe(1)
      expect(idx.queryEq(true).size).toBe(0)
    })

    it('does not affect the opposite set', () => {
      idx.insert('doc1', true)
      idx.insert('doc2', false)
      idx.remove('doc1', true)
      expect(idx.queryEq(false)).toEqual(new Set(['doc2']))
    })
  })

  describe('queryEq', () => {
    it('returns all true documents when querying for true', () => {
      idx.insert('doc1', true)
      idx.insert('doc2', false)
      idx.insert('doc3', true)
      expect(idx.queryEq(true)).toEqual(new Set(['doc1', 'doc3']))
    })

    it('returns all false documents when querying for false', () => {
      idx.insert('doc1', true)
      idx.insert('doc2', false)
      expect(idx.queryEq(false)).toEqual(new Set(['doc2']))
    })

    it('returns a copy, not a reference', () => {
      idx.insert('doc1', true)
      const result = idx.queryEq(true)
      result.add('rogue')
      expect(idx.queryEq(true).has('rogue')).toBe(false)
    })
  })

  describe('queryNe', () => {
    it('queryNe(true) returns false docs', () => {
      idx.insert('doc1', true)
      idx.insert('doc2', false)
      expect(idx.queryNe(true)).toEqual(new Set(['doc2']))
    })

    it('queryNe(false) returns true docs', () => {
      idx.insert('doc1', true)
      idx.insert('doc2', false)
      expect(idx.queryNe(false)).toEqual(new Set(['doc1']))
    })
  })

  describe('getAllDocIds', () => {
    it('returns all documents from both sets', () => {
      idx.insert('doc1', true)
      idx.insert('doc2', false)
      idx.insert('doc3', true)
      expect(idx.getAllDocIds()).toEqual(new Set(['doc1', 'doc2', 'doc3']))
    })
  })

  describe('clear', () => {
    it('empties both sets', () => {
      idx.insert('doc1', true)
      idx.insert('doc2', false)
      idx.clear()
      expect(idx.count()).toBe(0)
      expect(idx.queryEq(true).size).toBe(0)
      expect(idx.queryEq(false).size).toBe(0)
    })
  })

  describe('serialize and deserialize', () => {
    it('roundtrips through serialization', () => {
      idx.insert('doc1', true)
      idx.insert('doc2', false)
      idx.insert('doc3', true)

      const data = idx.serialize()
      const restored = createBooleanIndex()
      restored.deserialize(data)

      expect(restored.queryEq(true)).toEqual(new Set(['doc1', 'doc3']))
      expect(restored.queryEq(false)).toEqual(new Set(['doc2']))
    })

    it('serializes to arrays of docIds', () => {
      idx.insert('doc1', true)
      idx.insert('doc2', false)
      const data = idx.serialize()
      expect(data.trueDocs).toContain('doc1')
      expect(data.falseDocs).toContain('doc2')
    })

    it('deserialize replaces existing state', () => {
      idx.insert('old', true)
      idx.deserialize({ trueDocs: ['new1'], falseDocs: ['new2'] })
      expect(idx.queryEq(true)).toEqual(new Set(['new1']))
      expect(idx.queryEq(false)).toEqual(new Set(['new2']))
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
      idx.insert('doc1', 'red')
      idx.insert('doc2', 'blue')
      idx.insert('doc3', 'red')
      expect(idx.count()).toBe(3)
    })
  })

  describe('remove', () => {
    it('removes a docId from a specific value', () => {
      idx.insert('doc1', 'red')
      idx.insert('doc2', 'red')
      idx.remove('doc1', 'red')
      expect(idx.queryEq('red')).toEqual(new Set(['doc2']))
    })

    it('cleans up the value key when the last doc is removed', () => {
      idx.insert('doc1', 'rare')
      idx.remove('doc1', 'rare')
      expect(idx.queryEq('rare').size).toBe(0)
      expect(idx.count()).toBe(0)
    })

    it('does nothing for a non-existent value', () => {
      idx.insert('doc1', 'red')
      idx.remove('doc1', 'green')
      expect(idx.count()).toBe(1)
    })
  })

  describe('queryEq', () => {
    it('returns all docIds for a given enum value', () => {
      idx.insert('doc1', 'red')
      idx.insert('doc2', 'blue')
      idx.insert('doc3', 'red')
      expect(idx.queryEq('red')).toEqual(new Set(['doc1', 'doc3']))
    })

    it('returns empty set for non-existent value', () => {
      expect(idx.queryEq('missing').size).toBe(0)
    })

    it('returns a copy, not a reference to internal state', () => {
      idx.insert('doc1', 'red')
      const result = idx.queryEq('red')
      result.add('rogue')
      expect(idx.queryEq('red').has('rogue')).toBe(false)
    })
  })

  describe('queryNe', () => {
    it('returns all docIds NOT matching the given value', () => {
      idx.insert('doc1', 'red')
      idx.insert('doc2', 'blue')
      idx.insert('doc3', 'green')
      expect(idx.queryNe('red')).toEqual(new Set(['doc2', 'doc3']))
    })

    it('returns all docIds when the excluded value has no entries', () => {
      idx.insert('doc1', 'red')
      idx.insert('doc2', 'blue')
      expect(idx.queryNe('missing')).toEqual(new Set(['doc1', 'doc2']))
    })
  })

  describe('queryIn', () => {
    it('returns the union of docIds across multiple values', () => {
      idx.insert('doc1', 'red')
      idx.insert('doc2', 'blue')
      idx.insert('doc3', 'green')
      expect(idx.queryIn(['red', 'green'])).toEqual(new Set(['doc1', 'doc3']))
    })

    it('handles values that do not exist in the index', () => {
      idx.insert('doc1', 'red')
      expect(idx.queryIn(['red', 'missing'])).toEqual(new Set(['doc1']))
    })

    it('returns empty set for an empty values list', () => {
      idx.insert('doc1', 'red')
      expect(idx.queryIn([]).size).toBe(0)
    })
  })

  describe('queryNin', () => {
    it('returns docIds NOT matching any of the given values', () => {
      idx.insert('doc1', 'red')
      idx.insert('doc2', 'blue')
      idx.insert('doc3', 'green')
      idx.insert('doc4', 'red')
      expect(idx.queryNin(['red', 'blue'])).toEqual(new Set(['doc3']))
    })

    it('returns all docIds when excluding non-existent values', () => {
      idx.insert('doc1', 'red')
      idx.insert('doc2', 'blue')
      expect(idx.queryNin(['missing'])).toEqual(new Set(['doc1', 'doc2']))
    })
  })

  describe('getAllDocIds', () => {
    it('returns unique docIds across all values', () => {
      idx.insert('doc1', 'red')
      idx.insert('doc1', 'blue')
      idx.insert('doc2', 'green')
      expect(idx.getAllDocIds()).toEqual(new Set(['doc1', 'doc2']))
    })

    it('returns empty set for an empty index', () => {
      expect(idx.getAllDocIds().size).toBe(0)
    })
  })

  describe('clear', () => {
    it('removes all entries', () => {
      idx.insert('doc1', 'red')
      idx.insert('doc2', 'blue')
      idx.clear()
      expect(idx.count()).toBe(0)
      expect(idx.queryEq('red').size).toBe(0)
    })
  })

  describe('serialize and deserialize', () => {
    it('roundtrips through serialization', () => {
      idx.insert('doc1', 'red')
      idx.insert('doc2', 'blue')
      idx.insert('doc3', 'red')

      const data = idx.serialize()
      const restored = createEnumIndex()
      restored.deserialize(data)

      expect(restored.queryEq('red')).toEqual(new Set(['doc1', 'doc3']))
      expect(restored.queryEq('blue')).toEqual(new Set(['doc2']))
    })

    it('serializes to a value -> docId[] mapping', () => {
      idx.insert('doc1', 'red')
      idx.insert('doc2', 'red')
      const data = idx.serialize()
      expect(data.red).toContain('doc1')
      expect(data.red).toContain('doc2')
    })

    it('deserialize replaces existing state', () => {
      idx.insert('old', 'stale')
      idx.deserialize({ fresh: ['new1', 'new2'] })
      expect(idx.queryEq('stale').size).toBe(0)
      expect(idx.queryEq('fresh')).toEqual(new Set(['new1', 'new2']))
    })
  })
})
