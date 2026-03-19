import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../core/fuzzy', () => ({
  boundedLevenshtein(a: string, b: string, tolerance: number) {
    const m = a.length
    const n = b.length
    if (Math.abs(m - n) > tolerance) return { distance: tolerance + 1, withinTolerance: false }
    let prev = Array.from({ length: n + 1 }, (_, i) => i)
    let curr = new Array<number>(n + 1)
    for (let i = 1; i <= m; i++) {
      curr[0] = i
      let rowMin = i
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        rowMin = Math.min(rowMin, curr[j])
      }
      if (rowMin > tolerance) return { distance: rowMin, withinTolerance: false }
      ;[prev, curr] = [curr, prev]
    }
    const distance = prev[n]
    return { distance, withinTolerance: distance <= tolerance }
  },
}))

import { createInvertedIndex, type InvertedIndex } from '../../core/inverted-index'
import type { FieldNameTable } from '../../types/internal'

function createTable(): FieldNameTable {
  return { names: [], indexMap: new Map() }
}

function fieldIdx(table: FieldNameTable, name: string): number {
  const existing = table.indexMap.get(name)
  if (existing !== undefined) return existing
  const idx = table.names.length
  table.names.push(name)
  table.indexMap.set(name, idx)
  return idx
}

describe('InvertedIndex', () => {
  let idx: InvertedIndex
  let table: FieldNameTable

  beforeEach(() => {
    table = createTable()
    idx = createInvertedIndex(table)
  })

  describe('insert and lookup', () => {
    it('inserts a posting entry and looks it up by token', () => {
      idx.insert('sword', 'doc1', 1, fieldIdx(table, 'title'), [0])
      const list = idx.lookup('sword')
      expect(list).toBeDefined()
      expect(list?.docIdSet.size).toBe(1)
      expect(list?.length).toBe(1)
      expect(list?.docIds[0]).toBe('doc1')
    })

    it('returns undefined for a non-existent token', () => {
      expect(idx.lookup('missing')).toBeUndefined()
    })

    it('tracks separate entries for the same token across different fields', () => {
      idx.insert('narsil', 'doc1', 2, fieldIdx(table, 'title'), [0, 5])
      idx.insert('narsil', 'doc1', 1, fieldIdx(table, 'body'), [12])
      const list = idx.lookup('narsil')
      expect(list).toBeDefined()
      expect(list?.length).toBe(2)
      expect(list?.docIdSet.size).toBe(1)
    })

    it('tracks separate entries across different documents', () => {
      idx.insert('blade', 'doc1', 1, fieldIdx(table, 'title'), [0])
      idx.insert('blade', 'doc2', 1, fieldIdx(table, 'title'), [0])
      const list = idx.lookup('blade')
      expect(list).toBeDefined()
      expect(list?.length).toBe(2)
      expect(list?.docIdSet.size).toBe(2)
    })
  })

  describe('remove', () => {
    it('removes all entries for a docId from a token', () => {
      idx.insert('steel', 'doc1', 1, fieldIdx(table, 'title'), [0])
      idx.insert('steel', 'doc1', 2, fieldIdx(table, 'body'), [0, 3])
      idx.remove('steel', 'doc1')
      expect(idx.lookup('steel')).toBeUndefined()
    })

    it('removes only the specified docId, keeping others', () => {
      idx.insert('steel', 'doc1', 1, fieldIdx(table, 'title'), [0])
      idx.insert('steel', 'doc2', 1, fieldIdx(table, 'title'), [0])
      idx.remove('steel', 'doc1')
      const list = idx.lookup('steel')
      expect(list).toBeDefined()
      expect(list?.length).toBe(1)
      expect(list?.docIds[0]).toBe('doc2')
      expect(list?.docIdSet.size).toBe(1)
    })

    it('does nothing when the token does not exist', () => {
      idx.remove('nonexistent', 'doc1')
      expect(idx.size()).toBe(0)
    })

    it('does nothing when the docId does not exist under the token', () => {
      idx.insert('steel', 'doc1', 1, fieldIdx(table, 'title'), [0])
      idx.remove('steel', 'doc99')
      expect(idx.lookup('steel')?.length).toBe(1)
    })

    it('cleans up the token entirely when the last posting is removed', () => {
      idx.insert('rare', 'doc1', 1, fieldIdx(table, 'title'), [0])
      idx.remove('rare', 'doc1')
      expect(idx.has('rare')).toBe(false)
      expect(idx.size()).toBe(0)
    })
  })

  describe('has, tokens, size', () => {
    it('has returns true for existing tokens', () => {
      idx.insert('exists', 'doc1', 1, fieldIdx(table, 'title'), [0])
      expect(idx.has('exists')).toBe(true)
    })

    it('has returns false for missing tokens', () => {
      expect(idx.has('nope')).toBe(false)
    })

    it('tokens iterates all token strings', () => {
      idx.insert('alpha', 'doc1', 1, fieldIdx(table, 'title'), [0])
      idx.insert('beta', 'doc1', 1, fieldIdx(table, 'title'), [1])
      idx.insert('gamma', 'doc1', 1, fieldIdx(table, 'title'), [2])
      const tokenList = Array.from(idx.tokens())
      expect(tokenList).toHaveLength(3)
      expect(tokenList).toContain('alpha')
      expect(tokenList).toContain('beta')
      expect(tokenList).toContain('gamma')
    })

    it('size returns the number of unique tokens', () => {
      idx.insert('one', 'doc1', 1, fieldIdx(table, 'title'), [0])
      idx.insert('two', 'doc1', 1, fieldIdx(table, 'title'), [1])
      idx.insert('one', 'doc2', 1, fieldIdx(table, 'title'), [0])
      expect(idx.size()).toBe(2)
    })
  })

  describe('clear', () => {
    it('empties the entire index', () => {
      idx.insert('a', 'doc1', 1, fieldIdx(table, 'title'), [0])
      idx.insert('b', 'doc2', 1, fieldIdx(table, 'title'), [0])
      idx.clear()
      expect(idx.size()).toBe(0)
      expect(idx.lookup('a')).toBeUndefined()
      expect(idx.has('b')).toBe(false)
    })
  })

  describe('fuzzyLookup', () => {
    beforeEach(() => {
      idx.insert('cat', 'doc1', 1, fieldIdx(table, 'title'), [0])
      idx.insert('car', 'doc2', 1, fieldIdx(table, 'title'), [0])
      idx.insert('cap', 'doc3', 1, fieldIdx(table, 'title'), [0])
      idx.insert('bat', 'doc4', 1, fieldIdx(table, 'title'), [0])
      idx.insert('dog', 'doc5', 1, fieldIdx(table, 'title'), [0])
    })

    it('with tolerance 0, returns only exact matches', () => {
      const results = idx.fuzzyLookup('cat', 0, 0)
      expect(results).toHaveLength(1)
      expect(results[0].token).toBe('cat')
    })

    it('with tolerance 1 and no prefix filter, finds tokens within edit distance 1', () => {
      const results = idx.fuzzyLookup('cat', 1, 0)
      const tokens = results.map(r => r.token).sort()
      expect(tokens).toContain('cat')
      expect(tokens).toContain('car')
      expect(tokens).toContain('cap')
      expect(tokens).toContain('bat')
      expect(tokens).not.toContain('dog')
    })

    it('with prefixLength 1, only checks tokens sharing the first character', () => {
      const results = idx.fuzzyLookup('cat', 1, 1)
      const tokens = results.map(r => r.token).sort()
      expect(tokens).toContain('cat')
      expect(tokens).toContain('car')
      expect(tokens).toContain('cap')
      expect(tokens).not.toContain('bat')
    })

    it('returns an empty array when no tokens match', () => {
      const results = idx.fuzzyLookup('xyz', 1, 0)
      expect(results).toHaveLength(0)
    })

    it('returns empty for an empty index', () => {
      idx.clear()
      const results = idx.fuzzyLookup('cat', 1, 0)
      expect(results).toHaveLength(0)
    })

    it('with prefixLength > 1, narrows candidates to those sharing the prefix', () => {
      idx.insert('cob', 'doc6', 1, fieldIdx(table, 'title'), [0])
      idx.insert('cup', 'doc7', 1, fieldIdx(table, 'title'), [0])
      const results = idx.fuzzyLookup('cat', 1, 2)
      const tokens = results.map(r => r.token).sort()
      expect(tokens).toContain('cat')
      expect(tokens).toContain('car')
      expect(tokens).toContain('cap')
      expect(tokens).not.toContain('cob')
      expect(tokens).not.toContain('cup')
      expect(tokens).not.toContain('dog')
    })

    it('each result includes the correct posting list', () => {
      const results = idx.fuzzyLookup('cat', 0, 0)
      expect(results[0].postingList.docIds[0]).toBe('doc1')
    })
  })

  describe('serialize and deserialize', () => {
    it('roundtrips through serialization', () => {
      idx.insert('flame', 'doc1', 2, fieldIdx(table, 'title'), [0, 7])
      idx.insert('flame', 'doc2', 1, fieldIdx(table, 'body'), [3])
      idx.insert('steel', 'doc1', 1, fieldIdx(table, 'title'), [2])

      const serialized = idx.serialize()
      const restoredTable = createTable()
      const restored = createInvertedIndex(restoredTable)
      restored.deserialize(serialized)

      expect(restored.size()).toBe(2)
      const flameList = restored.lookup('flame')
      expect(flameList).toBeDefined()
      expect(flameList?.docIdSet.size).toBe(2)
      expect(flameList?.length).toBe(2)
      expect(restored.lookup('steel')?.docIdSet.size).toBe(1)
    })

    it('serializes to a plain object', () => {
      idx.insert('token', 'doc1', 1, fieldIdx(table, 'title'), [0])
      const serialized = idx.serialize()
      expect(typeof serialized).toBe('object')
      expect(serialized.token).toBeDefined()
      expect(serialized.token.docFrequency).toBe(1)
    })

    it('deserialize replaces existing state', () => {
      idx.insert('old', 'doc1', 1, fieldIdx(table, 'title'), [0])
      idx.deserialize({
        fresh: {
          docFrequency: 1,
          postings: [{ docId: 'doc9', termFrequency: 1, fieldName: 'title', positions: [0] }],
        },
      })
      expect(idx.has('old')).toBe(false)
      expect(idx.has('fresh')).toBe(true)
      expect(idx.size()).toBe(1)
    })

    it('fuzzyLookup works after deserialization (prefix buckets rebuilt)', () => {
      idx.insert('cat', 'd1', 1, fieldIdx(table, 'title'), [0])
      idx.insert('car', 'd2', 1, fieldIdx(table, 'title'), [0])

      const serialized = idx.serialize()
      const restoredTable = createTable()
      const restored = createInvertedIndex(restoredTable)
      restored.deserialize(serialized)

      const results = restored.fuzzyLookup('cat', 1, 1)
      const tokens = results.map(r => r.token).sort()
      expect(tokens).toContain('cat')
      expect(tokens).toContain('car')
    })
  })

  describe('null positions', () => {
    it('stores null positions when positions are not tracked', () => {
      idx.insert('term', 'doc1', 3, fieldIdx(table, 'title'), null)
      const list = idx.lookup('term')
      expect(list).toBeDefined()
      expect(list?.positions).toBeNull()
      expect(list?.termFrequencies[0]).toBe(3)
    })

    it('handles mixed positions and null in same list', () => {
      idx.insert('term', 'doc1', 1, fieldIdx(table, 'title'), [0, 5])
      idx.insert('term', 'doc2', 2, fieldIdx(table, 'body'), null)
      const list = idx.lookup('term')
      expect(list?.length).toBe(2)
      expect(list?.positions).toBeDefined()
      expect(list?.positions?.[0]).toEqual([0, 5])
      expect(list?.positions?.[1]).toEqual([])
    })
  })

  describe('typed array growth', () => {
    it('grows typed arrays when capacity is exceeded', () => {
      const titleIdx = fieldIdx(table, 'title')
      for (let i = 0; i < 10; i++) {
        idx.insert('popular', `doc${i}`, 1, titleIdx, null)
      }
      const list = idx.lookup('popular')
      expect(list?.length).toBe(10)
      expect(list?.docIdSet.size).toBe(10)
      expect(list?.termFrequencies.length).toBeGreaterThanOrEqual(10)
    })
  })
})
