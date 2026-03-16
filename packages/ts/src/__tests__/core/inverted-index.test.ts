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
import type { PostingEntry } from '../../types/internal'

function entry(docId: string, fieldName: string, termFrequency: number, positions: number[]): PostingEntry {
  return { docId, fieldName, termFrequency, positions }
}

describe('InvertedIndex', () => {
  let idx: InvertedIndex

  beforeEach(() => {
    idx = createInvertedIndex()
  })

  describe('insert and lookup', () => {
    it('inserts a posting entry and looks it up by token', () => {
      idx.insert('sword', entry('doc1', 'title', 1, [0]))
      const list = idx.lookup('sword')
      expect(list).toBeDefined()
      expect(list?.docFrequency).toBe(1)
      expect(list?.postings).toHaveLength(1)
      expect(list?.postings[0].docId).toBe('doc1')
    })

    it('returns undefined for a non-existent token', () => {
      expect(idx.lookup('missing')).toBeUndefined()
    })

    it('tracks separate entries for the same token across different fields', () => {
      idx.insert('narsil', entry('doc1', 'title', 2, [0, 5]))
      idx.insert('narsil', entry('doc1', 'body', 1, [12]))
      const list = idx.lookup('narsil')
      expect(list).toBeDefined()
      expect(list?.postings).toHaveLength(2)
      expect(list?.docFrequency).toBe(1)
    })

    it('tracks separate entries across different documents', () => {
      idx.insert('blade', entry('doc1', 'title', 1, [0]))
      idx.insert('blade', entry('doc2', 'title', 1, [0]))
      const list = idx.lookup('blade')
      expect(list).toBeDefined()
      expect(list?.postings).toHaveLength(2)
      expect(list?.docFrequency).toBe(2)
    })
  })

  describe('remove', () => {
    it('removes all entries for a docId from a token', () => {
      idx.insert('steel', entry('doc1', 'title', 1, [0]))
      idx.insert('steel', entry('doc1', 'body', 2, [0, 3]))
      idx.remove('steel', 'doc1')
      expect(idx.lookup('steel')).toBeUndefined()
    })

    it('removes only the specified docId, keeping others', () => {
      idx.insert('steel', entry('doc1', 'title', 1, [0]))
      idx.insert('steel', entry('doc2', 'title', 1, [0]))
      idx.remove('steel', 'doc1')
      const list = idx.lookup('steel')
      expect(list).toBeDefined()
      expect(list?.postings).toHaveLength(1)
      expect(list?.postings[0].docId).toBe('doc2')
      expect(list?.docFrequency).toBe(1)
    })

    it('does nothing when the token does not exist', () => {
      idx.remove('nonexistent', 'doc1')
      expect(idx.size()).toBe(0)
    })

    it('does nothing when the docId does not exist under the token', () => {
      idx.insert('steel', entry('doc1', 'title', 1, [0]))
      idx.remove('steel', 'doc99')
      expect(idx.lookup('steel')?.postings).toHaveLength(1)
    })

    it('cleans up the token entirely when the last posting is removed', () => {
      idx.insert('rare', entry('doc1', 'title', 1, [0]))
      idx.remove('rare', 'doc1')
      expect(idx.has('rare')).toBe(false)
      expect(idx.size()).toBe(0)
    })
  })

  describe('has, tokens, size', () => {
    it('has returns true for existing tokens', () => {
      idx.insert('exists', entry('doc1', 'title', 1, [0]))
      expect(idx.has('exists')).toBe(true)
    })

    it('has returns false for missing tokens', () => {
      expect(idx.has('nope')).toBe(false)
    })

    it('tokens iterates all token strings', () => {
      idx.insert('alpha', entry('doc1', 'title', 1, [0]))
      idx.insert('beta', entry('doc1', 'title', 1, [1]))
      idx.insert('gamma', entry('doc1', 'title', 1, [2]))
      const tokenList = Array.from(idx.tokens())
      expect(tokenList).toHaveLength(3)
      expect(tokenList).toContain('alpha')
      expect(tokenList).toContain('beta')
      expect(tokenList).toContain('gamma')
    })

    it('size returns the number of unique tokens', () => {
      idx.insert('one', entry('doc1', 'title', 1, [0]))
      idx.insert('two', entry('doc1', 'title', 1, [1]))
      idx.insert('one', entry('doc2', 'title', 1, [0]))
      expect(idx.size()).toBe(2)
    })
  })

  describe('clear', () => {
    it('empties the entire index', () => {
      idx.insert('a', entry('doc1', 'title', 1, [0]))
      idx.insert('b', entry('doc2', 'title', 1, [0]))
      idx.clear()
      expect(idx.size()).toBe(0)
      expect(idx.lookup('a')).toBeUndefined()
      expect(idx.has('b')).toBe(false)
    })
  })

  describe('fuzzyLookup', () => {
    beforeEach(() => {
      idx.insert('cat', entry('doc1', 'title', 1, [0]))
      idx.insert('car', entry('doc2', 'title', 1, [0]))
      idx.insert('cap', entry('doc3', 'title', 1, [0]))
      idx.insert('bat', entry('doc4', 'title', 1, [0]))
      idx.insert('dog', entry('doc5', 'title', 1, [0]))
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
      idx.insert('cob', entry('doc6', 'title', 1, [0]))
      idx.insert('cup', entry('doc7', 'title', 1, [0]))
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
      expect(results[0].postingList.postings[0].docId).toBe('doc1')
    })
  })

  describe('serialize and deserialize', () => {
    it('roundtrips through serialization', () => {
      idx.insert('flame', entry('doc1', 'title', 2, [0, 7]))
      idx.insert('flame', entry('doc2', 'body', 1, [3]))
      idx.insert('steel', entry('doc1', 'title', 1, [2]))

      const serialized = idx.serialize()
      const restored = createInvertedIndex()
      restored.deserialize(serialized)

      expect(restored.size()).toBe(2)
      const flameList = restored.lookup('flame')
      expect(flameList).toBeDefined()
      expect(flameList?.docFrequency).toBe(2)
      expect(flameList?.postings).toHaveLength(2)
      expect(restored.lookup('steel')?.docFrequency).toBe(1)
    })

    it('serializes to a plain object', () => {
      idx.insert('token', entry('doc1', 'title', 1, [0]))
      const serialized = idx.serialize()
      expect(typeof serialized).toBe('object')
      expect(serialized.token).toBeDefined()
      expect(serialized.token.docFrequency).toBe(1)
    })

    it('deserialize replaces existing state', () => {
      idx.insert('old', entry('doc1', 'title', 1, [0]))
      idx.deserialize({
        fresh: { docFrequency: 1, postings: [entry('doc9', 'title', 1, [0])] },
      })
      expect(idx.has('old')).toBe(false)
      expect(idx.has('fresh')).toBe(true)
      expect(idx.size()).toBe(1)
    })

    it('fuzzyLookup works after deserialization (prefix buckets rebuilt)', () => {
      idx.insert('cat', entry('d1', 'title', 1, [0]))
      idx.insert('car', entry('d2', 'title', 1, [0]))

      const serialized = idx.serialize()
      const restored = createInvertedIndex()
      restored.deserialize(serialized)

      const results = restored.fuzzyLookup('cat', 1, 1)
      const tokens = results.map(r => r.token).sort()
      expect(tokens).toContain('cat')
      expect(tokens).toContain('car')
    })
  })
})
