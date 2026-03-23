import { describe, expect, it } from 'vitest'
import { averagePrecision, ndcgAtK, precisionAtK, type RelevanceMap, reciprocalRank } from './metrics'

describe('IR Metrics', () => {
  describe('ndcgAtK', () => {
    it('returns 1.0 for a perfect ranking', () => {
      const judgments: RelevanceMap = new Map([
        ['a', 3],
        ['b', 2],
        ['c', 1],
      ])
      expect(ndcgAtK(['a', 'b', 'c'], judgments, 3)).toBeCloseTo(1.0, 4)
    })

    it('penalizes an inverted ranking', () => {
      const judgments: RelevanceMap = new Map([
        ['a', 3],
        ['b', 2],
        ['c', 1],
      ])
      const perfect = ndcgAtK(['a', 'b', 'c'], judgments, 3)
      const inverted = ndcgAtK(['c', 'b', 'a'], judgments, 3)
      expect(inverted).toBeLessThan(perfect)
      expect(inverted).toBeGreaterThan(0)
    })

    it('computes correct nDCG@3 for a known ranking', () => {
      const judgments: RelevanceMap = new Map([
        ['a', 3],
        ['b', 2],
        ['c', 1],
      ])
      const dcg = (2 ** 1 - 1) / Math.log2(2) + (2 ** 2 - 1) / Math.log2(3) + (2 ** 3 - 1) / Math.log2(4)
      const idcg = (2 ** 3 - 1) / Math.log2(2) + (2 ** 2 - 1) / Math.log2(3) + (2 ** 1 - 1) / Math.log2(4)
      expect(ndcgAtK(['c', 'b', 'a'], judgments, 3)).toBeCloseTo(dcg / idcg, 4)
    })

    it('returns 0 for empty results', () => {
      const judgments: RelevanceMap = new Map([['a', 3]])
      expect(ndcgAtK([], judgments, 10)).toBe(0)
    })

    it('returns 0 when no relevant documents exist', () => {
      const judgments: RelevanceMap = new Map([['a', 0]])
      expect(ndcgAtK(['a', 'b'], judgments, 3)).toBe(0)
    })

    it('treats unjudged documents as relevance 0', () => {
      const judgments: RelevanceMap = new Map([['a', 3]])
      const withUnjudged = ndcgAtK(['x', 'a'], judgments, 2)
      const withoutUnjudged = ndcgAtK(['a', 'x'], judgments, 2)
      expect(withoutUnjudged).toBeGreaterThan(withUnjudged)
    })

    it('truncates results to k', () => {
      const judgments: RelevanceMap = new Map([
        ['a', 1],
        ['b', 3],
      ])
      const atK1 = ndcgAtK(['a', 'b'], judgments, 1)
      const atK2 = ndcgAtK(['a', 'b'], judgments, 2)
      expect(atK1).not.toEqual(atK2)
    })
  })

  describe('precisionAtK', () => {
    it('returns 1.0 when all top-k are relevant', () => {
      const judgments: RelevanceMap = new Map([
        ['a', 2],
        ['b', 1],
        ['c', 3],
      ])
      expect(precisionAtK(['a', 'b', 'c'], judgments, 3)).toBeCloseTo(1.0, 4)
    })

    it('returns 0.0 when no top-k are relevant', () => {
      const judgments: RelevanceMap = new Map([['d', 3]])
      expect(precisionAtK(['a', 'b', 'c'], judgments, 3)).toBeCloseTo(0.0, 4)
    })

    it('computes fraction correctly', () => {
      const judgments: RelevanceMap = new Map([
        ['a', 2],
        ['c', 1],
      ])
      expect(precisionAtK(['a', 'b', 'c', 'd'], judgments, 4)).toBeCloseTo(0.5, 4)
    })

    it('returns 0 for empty results', () => {
      const judgments: RelevanceMap = new Map([['a', 3]])
      expect(precisionAtK([], judgments, 10)).toBe(0)
    })

    it('divides by k even when fewer results are returned', () => {
      const judgments: RelevanceMap = new Map([['a', 2]])
      expect(precisionAtK(['a'], judgments, 10)).toBeCloseTo(0.1, 4)
    })

    it('treats relevance 0 as non-relevant', () => {
      const judgments: RelevanceMap = new Map([
        ['a', 0],
        ['b', 1],
      ])
      expect(precisionAtK(['a', 'b'], judgments, 2)).toBeCloseTo(0.5, 4)
    })
  })

  describe('averagePrecision', () => {
    it('returns 1.0 when all relevant docs are at the top', () => {
      const judgments: RelevanceMap = new Map([
        ['a', 2],
        ['b', 1],
      ])
      expect(averagePrecision(['a', 'b', 'c', 'd'], judgments, 2)).toBeCloseTo(1.0, 4)
    })

    it('penalizes relevant docs ranked lower', () => {
      const judgments: RelevanceMap = new Map([
        ['a', 2],
        ['b', 1],
      ])
      const topRanked = averagePrecision(['a', 'b', 'c', 'd'], judgments, 2)
      const lowRanked = averagePrecision(['c', 'd', 'a', 'b'], judgments, 2)
      expect(lowRanked).toBeLessThan(topRanked)
    })

    it('computes AP for a known ranking', () => {
      const judgments: RelevanceMap = new Map([
        ['a', 1],
        ['c', 1],
      ])
      const ap = averagePrecision(['a', 'b', 'c', 'd'], judgments, 2)
      const expected = (1 / 1 + 2 / 3) / 2
      expect(ap).toBeCloseTo(expected, 4)
    })

    it('returns 0 when totalRelevant is 0', () => {
      const judgments: RelevanceMap = new Map()
      expect(averagePrecision(['a', 'b'], judgments, 0)).toBe(0)
    })

    it('returns 0 for empty results', () => {
      const judgments: RelevanceMap = new Map([['a', 2]])
      expect(averagePrecision([], judgments, 1)).toBe(0)
    })

    it('accounts for unretrieved relevant documents via totalRelevant', () => {
      const judgments: RelevanceMap = new Map([['a', 1]])
      const ap = averagePrecision(['a'], judgments, 3)
      expect(ap).toBeCloseTo(1 / 3, 4)
    })
  })

  describe('reciprocalRank', () => {
    it('returns 1.0 when the first result is relevant', () => {
      const judgments: RelevanceMap = new Map([['a', 2]])
      expect(reciprocalRank(['a', 'b', 'c'], judgments)).toBeCloseTo(1.0, 4)
    })

    it('returns 0.5 when the second result is the first relevant', () => {
      const judgments: RelevanceMap = new Map([['b', 1]])
      expect(reciprocalRank(['a', 'b', 'c'], judgments)).toBeCloseTo(0.5, 4)
    })

    it('returns 1/3 when the third result is the first relevant', () => {
      const judgments: RelevanceMap = new Map([['c', 1]])
      expect(reciprocalRank(['a', 'b', 'c'], judgments)).toBeCloseTo(1 / 3, 4)
    })

    it('returns 0 when no results are relevant', () => {
      const judgments: RelevanceMap = new Map([['d', 3]])
      expect(reciprocalRank(['a', 'b', 'c'], judgments)).toBe(0)
    })

    it('returns 0 for empty results', () => {
      const judgments: RelevanceMap = new Map([['a', 2]])
      expect(reciprocalRank([], judgments)).toBe(0)
    })

    it('ignores later relevant docs after the first', () => {
      const judgments: RelevanceMap = new Map([
        ['b', 1],
        ['c', 3],
      ])
      expect(reciprocalRank(['a', 'b', 'c'], judgments)).toBeCloseTo(0.5, 4)
    })
  })
})
