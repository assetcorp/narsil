import { describe, expect, it } from 'vitest'
import { applyGrouping } from '../../search/grouping'
import type { Hit } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { GroupConfig } from '../../types/search'

function makeHit(id: string, score: number): Hit {
  return { id, score, document: {} }
}

function makeDocStore(docs: Record<string, AnyDocument>): (docId: string) => AnyDocument | undefined {
  return (docId: string) => docs[docId]
}

describe('applyGrouping', () => {
  describe('group by single field', () => {
    it('groups hits by a single field value', () => {
      const docs: Record<string, AnyDocument> = {
        a: { category: 'fruit' },
        b: { category: 'vegetable' },
        c: { category: 'fruit' },
        d: { category: 'vegetable' },
      }
      const hits = [makeHit('a', 4), makeHit('b', 3), makeHit('c', 2), makeHit('d', 1)]
      const config: GroupConfig = { fields: ['category'] }
      const groups = applyGrouping(hits, config, makeDocStore(docs))

      expect(groups.length).toBe(2)

      const fruitGroup = groups.find(g => g.values.category === 'fruit')
      const vegGroup = groups.find(g => g.values.category === 'vegetable')
      expect(fruitGroup).toBeDefined()
      expect(vegGroup).toBeDefined()
      expect(fruitGroup?.hits.map(h => h.id)).toContain('a')
      expect(fruitGroup?.hits.map(h => h.id)).toContain('c')
      expect(vegGroup?.hits.map(h => h.id)).toContain('b')
      expect(vegGroup?.hits.map(h => h.id)).toContain('d')
    })
  })

  describe('group by multiple fields', () => {
    it('creates composite groups from multiple field values', () => {
      const docs: Record<string, AnyDocument> = {
        a: { category: 'fruit', color: 'red' },
        b: { category: 'fruit', color: 'green' },
        c: { category: 'fruit', color: 'red' },
      }
      const hits = [makeHit('a', 3), makeHit('b', 2), makeHit('c', 1)]
      const config: GroupConfig = { fields: ['category', 'color'] }
      const groups = applyGrouping(hits, config, makeDocStore(docs))

      expect(groups.length).toBe(2)

      const redFruitGroup = groups.find(g => g.values.category === 'fruit' && g.values.color === 'red')
      expect(redFruitGroup).toBeDefined()
      expect(redFruitGroup?.hits.length).toBe(2)
    })
  })

  describe('maxPerGroup', () => {
    it('limits the number of hits per group', () => {
      const docs: Record<string, AnyDocument> = {
        a: { category: 'fruit' },
        b: { category: 'fruit' },
        c: { category: 'fruit' },
      }
      const hits = [makeHit('a', 3), makeHit('b', 2), makeHit('c', 1)]
      const config: GroupConfig = { fields: ['category'], maxPerGroup: 2 }
      const groups = applyGrouping(hits, config, makeDocStore(docs))

      expect(groups.length).toBe(1)
      expect(groups[0].hits.length).toBe(2)
    })
  })

  describe('custom reducer', () => {
    it('applies the reducer to accumulate a value across group hits', () => {
      const docs: Record<string, AnyDocument> = {
        a: { category: 'fruit', price: 10 },
        b: { category: 'fruit', price: 20 },
      }
      const hits = [makeHit('a', 2), makeHit('b', 1)]
      const config: GroupConfig = {
        fields: ['category'],
        reduce: {
          reducer: (acc, doc) => (acc as number) + (doc.price as number),
          initialValue: () => 0,
        },
      }
      const groups = applyGrouping(hits, config, makeDocStore(docs))

      expect(groups.length).toBe(1)
      expect((groups[0] as Record<string, unknown>).reduced).toBe(30)
    })
  })

  describe('reducer that throws', () => {
    it('captures the error message instead of crashing', () => {
      const docs: Record<string, AnyDocument> = {
        a: { category: 'fruit' },
      }
      const hits = [makeHit('a', 1)]
      const config: GroupConfig = {
        fields: ['category'],
        reduce: {
          reducer: () => {
            throw new Error('reducer failed')
          },
          initialValue: () => 0,
        },
      }
      const groups = applyGrouping(hits, config, makeDocStore(docs))

      expect(groups.length).toBe(1)
      expect((groups[0] as Record<string, unknown>).reducerError).toBe('reducer failed')
    })
  })

  describe('missing field values', () => {
    it('groups documents with undefined field values together', () => {
      const docs: Record<string, AnyDocument> = {
        a: { category: 'fruit' },
        b: {},
        c: {},
      }
      const hits = [makeHit('a', 3), makeHit('b', 2), makeHit('c', 1)]
      const config: GroupConfig = { fields: ['category'] }
      const groups = applyGrouping(hits, config, makeDocStore(docs))

      expect(groups.length).toBe(2)

      const undefinedGroup = groups.find(g => g.values.category === undefined)
      expect(undefinedGroup).toBeDefined()
      expect(undefinedGroup?.hits.length).toBe(2)
    })
  })

  describe('empty hits', () => {
    it('returns no groups when there are no hits', () => {
      const config: GroupConfig = { fields: ['category'] }
      const groups = applyGrouping([], config, () => undefined)
      expect(groups).toEqual([])
    })
  })

  describe('empty fields', () => {
    it('returns a single group containing all hits when fields is empty', () => {
      const hits = [makeHit('a', 2), makeHit('b', 1)]
      const config: GroupConfig = { fields: [] }
      const groups = applyGrouping(hits, config, () => undefined)

      expect(groups.length).toBe(1)
      expect(groups[0].hits.length).toBe(2)
    })
  })

  describe('group ordering', () => {
    it('orders groups by highest-scoring first hit descending', () => {
      const docs: Record<string, AnyDocument> = {
        a: { category: 'vegetable' },
        b: { category: 'fruit' },
        c: { category: 'fruit' },
      }
      const hits = [makeHit('a', 10), makeHit('b', 5), makeHit('c', 3)]
      const config: GroupConfig = { fields: ['category'] }
      const groups = applyGrouping(hits, config, makeDocStore(docs))

      expect(groups[0].values.category).toBe('vegetable')
      expect(groups[1].values.category).toBe('fruit')
    })
  })
})
