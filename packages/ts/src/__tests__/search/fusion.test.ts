import { describe, expect, it } from 'vitest'
import { linearCombination, minMaxNormalize, reciprocalRankFusion } from '../../search/fusion'
import type { ScoredDocument } from '../../types/internal'

function makeScoredDoc(
  docId: string,
  score: number,
  overrides?: Partial<Pick<ScoredDocument, 'termFrequencies' | 'fieldLengths' | 'idf'>>,
): ScoredDocument {
  return {
    docId,
    score,
    termFrequencies: overrides?.termFrequencies ?? {},
    fieldLengths: overrides?.fieldLengths ?? {},
    idf: overrides?.idf ?? {},
  }
}

describe('minMaxNormalize', () => {
  it('returns an empty array when given no documents', () => {
    const result = minMaxNormalize([])
    expect(result).toEqual([])
  })

  it('returns score 1.0 for a single document', () => {
    const result = minMaxNormalize([makeScoredDoc('doc-1', 5.5)])
    expect(result).toEqual([{ docId: 'doc-1', score: 1.0 }])
  })

  it('returns all scores as 1.0 when every document has the same score', () => {
    const docs = [makeScoredDoc('a', 3.0), makeScoredDoc('b', 3.0), makeScoredDoc('c', 3.0)]
    const result = minMaxNormalize(docs)
    expect(result).toHaveLength(3)
    for (const entry of result) {
      expect(entry.score).toBe(1.0)
    }
  })

  it('maps min score to 0 and max score to 1 with proportional middle values', () => {
    const docs = [makeScoredDoc('low', 2.0), makeScoredDoc('mid', 6.0), makeScoredDoc('high', 10.0)]
    const result = minMaxNormalize(docs)

    const scoreMap = new Map(result.map(r => [r.docId, r.score]))
    expect(scoreMap.get('low')).toBeCloseTo(0.0, 10)
    expect(scoreMap.get('mid')).toBeCloseTo(0.5, 10)
    expect(scoreMap.get('high')).toBeCloseTo(1.0, 10)
  })

  it('normalizes negative scores correctly', () => {
    const docs = [makeScoredDoc('neg', -10.0), makeScoredDoc('zero', 0.0), makeScoredDoc('pos', 10.0)]
    const result = minMaxNormalize(docs)

    const scoreMap = new Map(result.map(r => [r.docId, r.score]))
    expect(scoreMap.get('neg')).toBeCloseTo(0.0, 10)
    expect(scoreMap.get('zero')).toBeCloseTo(0.5, 10)
    expect(scoreMap.get('pos')).toBeCloseTo(1.0, 10)
  })
})

describe('reciprocalRankFusion', () => {
  it('returns an empty array when all lists are empty', () => {
    const result = reciprocalRankFusion([], { k: 60 })
    expect(result).toEqual([])
  })

  it('returns an empty array for a single empty list', () => {
    const result = reciprocalRankFusion([[]], { k: 60 })
    expect(result).toEqual([])
  })

  it('preserves ranking order for a single list', () => {
    const list = [makeScoredDoc('first', 10), makeScoredDoc('second', 5), makeScoredDoc('third', 1)]
    const result = reciprocalRankFusion([list], { k: 60 })

    expect(result).toHaveLength(3)
    expect(result[0].docId).toBe('first')
    expect(result[1].docId).toBe('second')
    expect(result[2].docId).toBe('third')
  })

  it('ranks documents appearing in both lists higher than documents in only one', () => {
    const listA = [makeScoredDoc('shared', 10), makeScoredDoc('only-a', 5)]
    const listB = [makeScoredDoc('shared', 8), makeScoredDoc('only-b', 3)]

    const result = reciprocalRankFusion([listA, listB], { k: 60 })
    expect(result[0].docId).toBe('shared')
    expect(result[0].score).toBeGreaterThan(result[1].score)
  })

  it('varies score magnitudes based on the k parameter', () => {
    const list = [makeScoredDoc('doc-1', 10)]

    const resultK1 = reciprocalRankFusion([list], { k: 1 })
    const resultK60 = reciprocalRankFusion([list], { k: 60 })

    expect(resultK1[0].score).toBeCloseTo(1 / (1 + 0 + 1), 10)
    expect(resultK60[0].score).toBeCloseTo(1 / (60 + 0 + 1), 10)
    expect(resultK1[0].score).toBeGreaterThan(resultK60[0].score)
  })

  it('defaults k to 60 when k is zero or negative', () => {
    const list = [makeScoredDoc('doc-1', 10)]

    const resultZero = reciprocalRankFusion([list], { k: 0 })
    const resultNeg = reciprocalRankFusion([list], { k: -5 })
    const resultDefault = reciprocalRankFusion([list], { k: 60 })

    expect(resultZero[0].score).toBeCloseTo(resultDefault[0].score, 10)
    expect(resultNeg[0].score).toBeCloseTo(resultDefault[0].score, 10)
  })

  it('preserves metadata from the first occurrence of a duplicate document', () => {
    const tf1 = { search: 3 }
    const tf2 = { search: 7 }
    const listA = [makeScoredDoc('dup', 10, { termFrequencies: tf1 })]
    const listB = [makeScoredDoc('dup', 8, { termFrequencies: tf2 })]

    const result = reciprocalRankFusion([listA, listB], { k: 60 })
    expect(result[0].termFrequencies).toEqual(tf1)
  })

  it('sorts results by score descending, with ties broken by docId ascending', () => {
    const listA = [makeScoredDoc('charlie', 10)]
    const listB = [makeScoredDoc('alpha', 10)]

    const result = reciprocalRankFusion([listA, listB], { k: 60 })
    const alphaIdx = result.findIndex(d => d.docId === 'alpha')
    const charlieIdx = result.findIndex(d => d.docId === 'charlie')
    expect(alphaIdx).toBeLessThan(charlieIdx)
  })
})

describe('linearCombination', () => {
  it('uses only text scores when alpha is 0', () => {
    const textDocs = [makeScoredDoc('a', 10), makeScoredDoc('b', 5)]
    const vectorDocs = [makeScoredDoc('a', 1), makeScoredDoc('b', 100)]

    const result = linearCombination(textDocs, vectorDocs, { alpha: 0 })

    expect(result[0].docId).toBe('a')
    expect(result[1].docId).toBe('b')
  })

  it('uses only vector scores when alpha is 1', () => {
    const textDocs = [makeScoredDoc('a', 100), makeScoredDoc('b', 1)]
    const vectorDocs = [makeScoredDoc('a', 1), makeScoredDoc('b', 10)]

    const result = linearCombination(textDocs, vectorDocs, { alpha: 1 })

    expect(result[0].docId).toBe('b')
    expect(result[1].docId).toBe('a')
  })

  it('blends scores equally when alpha is 0.5', () => {
    const textDocs = [makeScoredDoc('x', 10), makeScoredDoc('y', 0)]
    const vectorDocs = [makeScoredDoc('x', 0), makeScoredDoc('y', 10)]

    const result = linearCombination(textDocs, vectorDocs, { alpha: 0.5 })

    expect(result[0].score).toBeCloseTo(result[1].score, 10)
  })

  it('gives a vector-only document a text score of 0', () => {
    const textDocs = [makeScoredDoc('text-only', 10)]
    const vectorDocs = [makeScoredDoc('vec-only', 8)]

    const result = linearCombination(textDocs, vectorDocs, { alpha: 0.5 })
    const vecDoc = result.find(d => d.docId === 'vec-only')
    expect(vecDoc).toBeDefined()
    if (vecDoc) {
      expect(vecDoc.score).toBeGreaterThan(0)
    }
  })

  it('gives a text-only document a vector score of 0', () => {
    const textDocs = [makeScoredDoc('text-only', 10)]
    const vectorDocs = [makeScoredDoc('vec-only', 8)]

    const result = linearCombination(textDocs, vectorDocs, { alpha: 0.5 })
    const textDoc = result.find(d => d.docId === 'text-only')
    expect(textDoc).toBeDefined()
    if (textDoc) {
      expect(textDoc.score).toBeGreaterThan(0)
    }
  })

  it('blends a document appearing in both lists', () => {
    const textDocs = [makeScoredDoc('shared', 10)]
    const vectorDocs = [makeScoredDoc('shared', 10)]

    const result = linearCombination(textDocs, vectorDocs, { alpha: 0.5 })
    expect(result).toHaveLength(1)
    expect(result[0].docId).toBe('shared')
    expect(result[0].score).toBeCloseTo(1.0, 10)
  })

  it('works with empty text results and non-empty vector results', () => {
    const vectorDocs = [makeScoredDoc('v1', 5), makeScoredDoc('v2', 10)]
    const result = linearCombination([], vectorDocs, { alpha: 0.7 })

    expect(result).toHaveLength(2)
    expect(result[0].score).toBeGreaterThan(0)
  })

  it('works with non-empty text results and empty vector results', () => {
    const textDocs = [makeScoredDoc('t1', 5), makeScoredDoc('t2', 10)]
    const result = linearCombination(textDocs, [], { alpha: 0.3 })

    expect(result).toHaveLength(2)
    expect(result[0].score).toBeGreaterThan(0)
  })

  it('returns an empty array when both inputs are empty', () => {
    const result = linearCombination([], [], { alpha: 0.5 })
    expect(result).toEqual([])
  })

  it('sorts results by score descending', () => {
    const textDocs = [makeScoredDoc('a', 1), makeScoredDoc('b', 10), makeScoredDoc('c', 5)]
    const vectorDocs = [makeScoredDoc('a', 1), makeScoredDoc('b', 10), makeScoredDoc('c', 5)]

    const result = linearCombination(textDocs, vectorDocs, { alpha: 0.5 })
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score)
    }
  })

  it('uses empty metadata for documents appearing only in vector results', () => {
    const vectorDocs = [makeScoredDoc('vec-only', 10, { termFrequencies: { narsil: 5 } })]
    const result = linearCombination([], vectorDocs, { alpha: 1.0 })

    expect(result[0].termFrequencies).toEqual({})
    expect(result[0].fieldLengths).toEqual({})
    expect(result[0].idf).toEqual({})
  })
})
