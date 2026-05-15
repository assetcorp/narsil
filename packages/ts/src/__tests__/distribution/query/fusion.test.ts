import { describe, expect, it } from 'vitest'
import {
  clampAlpha,
  distributedLinearCombination,
  distributedRRF,
  minMaxNormalizeScoredEntries,
} from '../../../distribution/query/fusion'
import type { ScoredEntry } from '../../../distribution/transport/types'

function entry(docId: string, score: number): ScoredEntry {
  return { docId, score, sortValues: null }
}

describe('distributedRRF', () => {
  it('computes correct RRF scores for two ranked lists', () => {
    const textList: ScoredEntry[] = [entry('doc-a', 10), entry('doc-b', 8), entry('doc-c', 5)]
    const vectorList: ScoredEntry[] = [entry('doc-c', 0.95), entry('doc-a', 0.8), entry('doc-d', 0.7)]

    const result = distributedRRF([textList, vectorList], { k: 60 })

    const scoreMap = new Map(result.map(r => [r.docId, r.score]))
    const docAScore = 1 / (60 + 0 + 1) + 1 / (60 + 1 + 1)
    const docBScore = 1 / (60 + 1 + 1)
    const docCScore = 1 / (60 + 2 + 1) + 1 / (60 + 0 + 1)
    const docDScore = 1 / (60 + 2 + 1)

    expect(scoreMap.get('doc-a')).toBeCloseTo(docAScore, 10)
    expect(scoreMap.get('doc-b')).toBeCloseTo(docBScore, 10)
    expect(scoreMap.get('doc-c')).toBeCloseTo(docCScore, 10)
    expect(scoreMap.get('doc-d')).toBeCloseTo(docDScore, 10)
  })

  it('returns results sorted by score descending', () => {
    const listA: ScoredEntry[] = [entry('doc-1', 10), entry('doc-2', 5)]
    const listB: ScoredEntry[] = [entry('doc-2', 0.9), entry('doc-1', 0.5)]

    const result = distributedRRF([listA, listB], { k: 60 })

    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score)
    }
  })

  it('uses docId as tiebreaker for equal fused scores', () => {
    const listA: ScoredEntry[] = [entry('beta', 10)]
    const listB: ScoredEntry[] = [entry('alpha', 10)]

    const result = distributedRRF([listA, listB], { k: 60 })

    expect(result[0].docId).toBe('alpha')
    expect(result[1].docId).toBe('beta')
    expect(result[0].score).toBe(result[1].score)
  })

  it('returns empty array for empty input lists', () => {
    const result = distributedRRF([[], []], { k: 60 })
    expect(result).toEqual([])
  })

  it('returns empty array when all lists are empty', () => {
    const result = distributedRRF([], { k: 60 })
    expect(result).toEqual([])
  })

  it('handles a single-item list', () => {
    const result = distributedRRF([[entry('doc-1', 5)]], { k: 60 })
    expect(result).toHaveLength(1)
    expect(result[0].docId).toBe('doc-1')
    expect(result[0].score).toBeCloseTo(1 / (60 + 0 + 1), 10)
  })

  it('produces sortValues: null on all fused entries', () => {
    const listA: ScoredEntry[] = [entry('doc-1', 10)]
    const listB: ScoredEntry[] = [entry('doc-2', 8)]

    const result = distributedRRF([listA, listB], { k: 60 })
    for (const r of result) {
      expect(r.sortValues).toBeNull()
    }
  })

  it('defaults k to 60 when k is zero', () => {
    const list: ScoredEntry[] = [entry('doc-1', 10)]
    const result = distributedRRF([list], { k: 0 })
    expect(result[0].score).toBeCloseTo(1 / (60 + 0 + 1), 10)
  })

  it('defaults k to 60 when k is negative', () => {
    const list: ScoredEntry[] = [entry('doc-1', 10)]
    const result = distributedRRF([list], { k: -5 })
    expect(result[0].score).toBeCloseTo(1 / (60 + 0 + 1), 10)
  })
})

describe('distributedLinearCombination', () => {
  it('combines text and vector scores with alpha=0.5', () => {
    const textResults: ScoredEntry[] = [entry('doc-a', 10), entry('doc-b', 5)]
    const vectorResults: ScoredEntry[] = [entry('doc-a', 0.8), entry('doc-c', 0.9)]

    const result = distributedLinearCombination(textResults, vectorResults, { alpha: 0.5 })

    const scoreMap = new Map(result.map(r => [r.docId, r.score]))
    expect(scoreMap.has('doc-a')).toBe(true)
    expect(scoreMap.has('doc-b')).toBe(true)
    expect(scoreMap.has('doc-c')).toBe(true)
  })

  it('with alpha=0, uses only text scores', () => {
    const textResults: ScoredEntry[] = [entry('doc-a', 10), entry('doc-b', 5)]
    const vectorResults: ScoredEntry[] = [entry('doc-a', 0.8), entry('doc-c', 0.9)]

    const result = distributedLinearCombination(textResults, vectorResults, { alpha: 0 })

    const scoreMap = new Map(result.map(r => [r.docId, r.score]))
    expect(scoreMap.get('doc-a')).toBeCloseTo(1.0, 10)
    expect(scoreMap.get('doc-b')).toBeCloseTo(0.0, 10)
    expect(scoreMap.get('doc-c')).toBeCloseTo(0.0, 10)
  })

  it('with alpha=1, uses only vector scores', () => {
    const textResults: ScoredEntry[] = [entry('doc-a', 10), entry('doc-b', 5)]
    const vectorResults: ScoredEntry[] = [entry('doc-a', 0.8), entry('doc-c', 0.9)]

    const result = distributedLinearCombination(textResults, vectorResults, { alpha: 1 })

    const scoreMap = new Map(result.map(r => [r.docId, r.score]))
    expect(scoreMap.get('doc-c')).toBeCloseTo(1.0, 10)
    expect(scoreMap.get('doc-a')).toBeCloseTo(0.0, 10)
    expect(scoreMap.get('doc-b')).toBeCloseTo(0.0, 10)
  })

  it('returns results sorted by score descending', () => {
    const textResults: ScoredEntry[] = [entry('doc-a', 10), entry('doc-b', 5), entry('doc-c', 1)]
    const vectorResults: ScoredEntry[] = [entry('doc-c', 0.95), entry('doc-b', 0.5), entry('doc-a', 0.1)]

    const result = distributedLinearCombination(textResults, vectorResults, { alpha: 0.5 })

    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score)
    }
  })

  it('uses docId as tiebreaker for equal combined scores', () => {
    const textResults: ScoredEntry[] = [entry('beta', 10), entry('alpha', 10)]
    const vectorResults: ScoredEntry[] = [entry('beta', 0.5), entry('alpha', 0.5)]

    const result = distributedLinearCombination(textResults, vectorResults, { alpha: 0.5 })

    expect(result[0].docId).toBe('alpha')
    expect(result[1].docId).toBe('beta')
  })

  it('returns empty array when both inputs are empty', () => {
    const result = distributedLinearCombination([], [], { alpha: 0.5 })
    expect(result).toEqual([])
  })

  it('handles text-only results with empty vector list', () => {
    const textResults: ScoredEntry[] = [entry('doc-a', 10), entry('doc-b', 5)]
    const result = distributedLinearCombination(textResults, [], { alpha: 0.5 })

    expect(result).toHaveLength(2)
    const scoreMap = new Map(result.map(r => [r.docId, r.score]))
    expect(scoreMap.get('doc-a')).toBeCloseTo(0.5, 10)
    expect(scoreMap.get('doc-b')).toBeCloseTo(0.0, 10)
  })

  it('handles vector-only results with empty text list', () => {
    const vectorResults: ScoredEntry[] = [entry('doc-a', 0.9), entry('doc-b', 0.5)]
    const result = distributedLinearCombination([], vectorResults, { alpha: 0.5 })

    expect(result).toHaveLength(2)
    const scoreMap = new Map(result.map(r => [r.docId, r.score]))
    expect(scoreMap.get('doc-a')).toBeCloseTo(0.5, 10)
    expect(scoreMap.get('doc-b')).toBeCloseTo(0.0, 10)
  })

  it('handles single-item lists', () => {
    const textResults: ScoredEntry[] = [entry('doc-a', 5)]
    const vectorResults: ScoredEntry[] = [entry('doc-a', 0.8)]

    const result = distributedLinearCombination(textResults, vectorResults, { alpha: 0.5 })

    expect(result).toHaveLength(1)
    expect(result[0].score).toBeCloseTo(1.0, 10)
  })

  it('produces sortValues: null on all fused entries', () => {
    const textResults: ScoredEntry[] = [entry('doc-a', 10)]
    const vectorResults: ScoredEntry[] = [entry('doc-b', 0.5)]

    const result = distributedLinearCombination(textResults, vectorResults, { alpha: 0.5 })
    for (const r of result) {
      expect(r.sortValues).toBeNull()
    }
  })
})

describe('minMaxNormalizeScoredEntries', () => {
  it('normalizes scores to [0, 1] range', () => {
    const entries: ScoredEntry[] = [entry('doc-a', 10), entry('doc-b', 5), entry('doc-c', 0)]

    const result = minMaxNormalizeScoredEntries(entries)

    expect(result).toHaveLength(3)
    const scoreMap = new Map(result.map(r => [r.docId, r.score]))
    expect(scoreMap.get('doc-a')).toBeCloseTo(1.0, 10)
    expect(scoreMap.get('doc-b')).toBeCloseTo(0.5, 10)
    expect(scoreMap.get('doc-c')).toBeCloseTo(0.0, 10)
  })

  it('returns all scores as 1.0 when all scores are equal', () => {
    const entries: ScoredEntry[] = [entry('doc-a', 5), entry('doc-b', 5), entry('doc-c', 5)]

    const result = minMaxNormalizeScoredEntries(entries)

    for (const r of result) {
      expect(r.score).toBe(1.0)
    }
  })

  it('returns empty array for empty input', () => {
    expect(minMaxNormalizeScoredEntries([])).toEqual([])
  })

  it('returns 1.0 for a single entry', () => {
    const result = minMaxNormalizeScoredEntries([entry('doc-a', 42)])
    expect(result).toHaveLength(1)
    expect(result[0].score).toBe(1.0)
  })

  it('handles negative scores correctly', () => {
    const entries: ScoredEntry[] = [entry('doc-a', -2), entry('doc-b', -5), entry('doc-c', -10)]

    const result = minMaxNormalizeScoredEntries(entries)

    const scoreMap = new Map(result.map(r => [r.docId, r.score]))
    expect(scoreMap.get('doc-a')).toBeCloseTo(1.0, 10)
    expect(scoreMap.get('doc-c')).toBeCloseTo(0.0, 10)
  })
})

describe('clampAlpha', () => {
  it('returns 0.5 for NaN', () => {
    expect(clampAlpha(NaN)).toBe(0.5)
  })

  it('returns 0.5 for Infinity', () => {
    expect(clampAlpha(Infinity)).toBe(0.5)
  })

  it('returns 0.5 for negative Infinity', () => {
    expect(clampAlpha(-Infinity)).toBe(0.5)
  })

  it('clamps negative values to 0', () => {
    expect(clampAlpha(-1)).toBe(0)
    expect(clampAlpha(-0.5)).toBe(0)
  })

  it('clamps values above 1 to 1', () => {
    expect(clampAlpha(2)).toBe(1)
    expect(clampAlpha(1.5)).toBe(1)
  })

  it('passes through valid values in [0, 1]', () => {
    expect(clampAlpha(0)).toBe(0)
    expect(clampAlpha(0.5)).toBe(0.5)
    expect(clampAlpha(1)).toBe(1)
    expect(clampAlpha(0.3)).toBe(0.3)
  })
})
