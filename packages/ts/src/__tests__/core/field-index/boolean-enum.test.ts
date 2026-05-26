import { beforeEach, describe, expect, it } from 'vitest'
import {
  type BooleanFieldIndex,
  createBooleanIndex,
  createEnumIndex,
  type EnumFieldIndex,
} from '../../../core/field-index'

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
