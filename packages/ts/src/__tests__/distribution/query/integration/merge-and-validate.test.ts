import { describe, expect, it } from 'vitest'
import { validateSearchResultPayload } from '../../../../distribution/query/codec'
import { mergeAndTruncateScoredEntries, mergeDistributedFacets } from '../../../../distribution/query/merge'
import type { FacetBucket, ScoredEntry } from '../../../../distribution/transport/types'

describe('mergeAndTruncateScoredEntries', () => {
  it('returns empty array for no input', () => {
    expect(mergeAndTruncateScoredEntries([], 10)).toEqual([])
  })

  it('returns single array truncated to limit', () => {
    const entries: ScoredEntry[] = [
      { docId: 'a', score: 5, sortValues: null },
      { docId: 'b', score: 4, sortValues: null },
      { docId: 'c', score: 3, sortValues: null },
    ]
    const result = mergeAndTruncateScoredEntries([entries], 2)
    expect(result).toHaveLength(2)
    expect(result[0].docId).toBe('a')
    expect(result[1].docId).toBe('b')
  })

  it('merges two sorted arrays maintaining score order', () => {
    const a: ScoredEntry[] = [
      { docId: 'a1', score: 10, sortValues: null },
      { docId: 'a2', score: 7, sortValues: null },
      { docId: 'a3', score: 3, sortValues: null },
    ]
    const b: ScoredEntry[] = [
      { docId: 'b1', score: 9, sortValues: null },
      { docId: 'b2', score: 5, sortValues: null },
    ]
    const result = mergeAndTruncateScoredEntries([a, b], 10)
    expect(result.map(e => e.docId)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3'])
  })

  it('uses docId as tiebreaker for equal scores', () => {
    const a: ScoredEntry[] = [{ docId: 'beta', score: 5, sortValues: null }]
    const b: ScoredEntry[] = [{ docId: 'alpha', score: 5, sortValues: null }]
    const result = mergeAndTruncateScoredEntries([a, b], 10)
    expect(result[0].docId).toBe('alpha')
    expect(result[1].docId).toBe('beta')
  })

  it('uses heap merge for more than 4 arrays', () => {
    const arrays: ScoredEntry[][] = []
    for (let i = 0; i < 6; i++) {
      arrays.push([
        { docId: `doc-${i}-a`, score: 10 - i, sortValues: null },
        { docId: `doc-${i}-b`, score: 5 - i * 0.5, sortValues: null },
      ])
    }

    const result = mergeAndTruncateScoredEntries(arrays, 5)
    expect(result).toHaveLength(5)

    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1]
      const curr = result[i]
      expect(prev.score).toBeGreaterThanOrEqual(curr.score)
    }
  })

  it('skips empty arrays', () => {
    const a: ScoredEntry[] = [{ docId: 'a', score: 5, sortValues: null }]
    const result = mergeAndTruncateScoredEntries([[], a, [], []], 10)
    expect(result).toHaveLength(1)
    expect(result[0].docId).toBe('a')
  })
})

describe('mergeDistributedFacets', () => {
  it('merges facets from multiple sources by summing counts', () => {
    const facets: Array<Record<string, FacetBucket[]>> = [
      {
        color: [
          { value: 'red', count: 10 },
          { value: 'blue', count: 5 },
        ],
      },
      {
        color: [
          { value: 'red', count: 8 },
          { value: 'green', count: 3 },
        ],
      },
    ]

    const result = mergeDistributedFacets(facets)

    expect(result.color).toHaveLength(3)
    expect(result.color[0]).toEqual({ value: 'red', count: 18 })
    expect(result.color[1]).toEqual({ value: 'blue', count: 5 })
    expect(result.color[2]).toEqual({ value: 'green', count: 3 })
  })

  it('handles multiple facet fields', () => {
    const facets: Array<Record<string, FacetBucket[]>> = [
      {
        color: [{ value: 'red', count: 5 }],
        size: [{ value: 'large', count: 3 }],
      },
      {
        color: [{ value: 'blue', count: 4 }],
        size: [
          { value: 'large', count: 2 },
          { value: 'small', count: 1 },
        ],
      },
    ]

    const result = mergeDistributedFacets(facets)

    expect(result.color).toHaveLength(2)
    expect(result.size).toHaveLength(2)
    expect(result.size[0]).toEqual({ value: 'large', count: 5 })
  })

  it('sorts buckets by count descending, then value ascending', () => {
    const facets: Array<Record<string, FacetBucket[]>> = [
      {
        tag: [
          { value: 'beta', count: 5 },
          { value: 'alpha', count: 5 },
          { value: 'gamma', count: 2 },
        ],
      },
    ]

    const result = mergeDistributedFacets(facets)

    expect(result.tag[0].value).toBe('alpha')
    expect(result.tag[1].value).toBe('beta')
    expect(result.tag[2].value).toBe('gamma')
  })

  it('returns empty object for empty input', () => {
    expect(mergeDistributedFacets([])).toEqual({})
  })

  it('truncates buckets to maxBuckets', () => {
    const buckets = Array.from({ length: 200 }, (_, i) => ({
      value: `val-${String(i).padStart(3, '0')}`,
      count: 200 - i,
    }))
    const facets = [{ category: buckets }]
    const result = mergeDistributedFacets(facets, 5)
    expect(result.category).toHaveLength(5)
    expect(result.category[0].count).toBe(200)
    expect(result.category[4].count).toBe(196)
  })
})

describe('validateSearchResultPayload', () => {
  it('rejects results with negative totalHits', () => {
    expect(() =>
      validateSearchResultPayload({
        results: [{ partitionId: 0, scored: [], totalHits: -1 }],
        facets: null,
      }),
    ).toThrow()
  })

  it('rejects results with NaN totalHits', () => {
    expect(() =>
      validateSearchResultPayload({
        results: [{ partitionId: 0, scored: [], totalHits: NaN }],
        facets: null,
      }),
    ).toThrow()
  })

  it('rejects scored entries with non-finite scores', () => {
    expect(() =>
      validateSearchResultPayload({
        results: [
          {
            partitionId: 0,
            scored: [{ docId: 'doc-1', score: Infinity, sortValues: null }],
            totalHits: 1,
          },
        ],
        facets: null,
      }),
    ).toThrow()
  })

  it('rejects oversized scored arrays', () => {
    const hugeScored = Array.from({ length: 10_001 }, (_, i) => ({
      docId: `doc-${i}`,
      score: 1.0,
      sortValues: null,
    }))

    expect(() =>
      validateSearchResultPayload({
        results: [{ partitionId: 0, scored: hugeScored, totalHits: 10_001 }],
        facets: null,
      }),
    ).toThrow()
  })

  it('accepts valid result payloads', () => {
    const result = validateSearchResultPayload({
      results: [
        {
          partitionId: 0,
          scored: [{ docId: 'doc-1', score: 5.0, sortValues: null }],
          totalHits: 1,
        },
      ],
      facets: null,
    })
    expect(result.results).toHaveLength(1)
  })
})
