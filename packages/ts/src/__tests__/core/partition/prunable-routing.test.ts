import { describe, expect, it } from 'vitest'
import { createInvertedIndex } from '../../../core/inverted-index'
import { MULTI_TERM_PRUNING_POSTINGS_THRESHOLD } from '../../../core/partition/constants'
import { prunableMultiTermLists } from '../../../core/partition/multi-term-topk'
import { prunableSingleTermList } from '../../../core/partition/search'
import type { FieldNameTable, InternalSearchParams } from '../../../types/internal'

const FIELD_NAMES = ['title']

function buildIndex(documentCount: number) {
  const fieldNameTable: FieldNameTable = { names: [...FIELD_NAMES], indexMap: new Map([['title', 0]]) }
  const index = createInvertedIndex(fieldNameTable)
  for (let internalId = 0; internalId < documentCount; internalId++) {
    index.insert('alpha', internalId, (internalId % 3) + 1, 0, null)
  }
  return index
}

function paramsFor(overrides: Partial<InternalSearchParams> = {}): InternalSearchParams {
  return {
    queryTokens: [{ token: 'alpha', position: 0 }],
    collectComponents: false,
    maxResults: 10,
    ...overrides,
  }
}

describe('routing to the pruned single-term scan', () => {
  it('routes the plain single-term query to the scan', () => {
    const index = buildIndex(20)
    expect(prunableSingleTermList(paramsFor(), index, FIELD_NAMES)).toBe(index.lookup('alpha'))
  })

  it('keeps routing to the scan while the list holds tombstones', () => {
    const index = buildIndex(20)
    index.remove('alpha', 7)
    const list = index.lookup('alpha')
    expect(list).toBeDefined()
    expect(list?.deletedDocs.size).toBe(1)
    expect(prunableSingleTermList(paramsFor(), index, FIELD_NAMES)).toBe(list)
  })

  it('refuses bm25 parameters outside the range the block bound is sound for', () => {
    const index = buildIndex(20)
    for (const bm25Params of [{ b: 2 }, { b: -1 }, { b: 1.001 }, { b: Number.NaN }, { k1: -1 }, { k1: Number.NaN }]) {
      expect(prunableSingleTermList(paramsFor({ bm25Params }), index, FIELD_NAMES)).toBeNull()
    }
    for (const bm25Params of [{ b: 0 }, { b: 1 }, { b: 0.75 }, { k1: 0 }, undefined]) {
      expect(prunableSingleTermList(paramsFor({ bm25Params }), index, FIELD_NAMES)).not.toBeNull()
    }
  })

  it('refuses every query shape the scan does not handle', () => {
    const index = buildIndex(20)
    const refused: Array<Partial<InternalSearchParams>> = [
      {
        queryTokens: [
          { token: 'alpha', position: 0 },
          { token: 'beta', position: 1 },
        ],
      },
      { prefixExpansion: { token: 'alpha', terms: ['alphabet'] } },
      { tolerance: 1 },
      { termMatch: 'all' },
      { collectComponents: true },
      { collectComponents: undefined },
      { collectMatchedSet: 'ordinals' },
      { maxResults: undefined },
      { fields: ['body'] },
      { filterBitset: new Uint32Array(1) },
      { queryTokens: [{ token: 'missing', position: 0 }] },
    ]
    for (const overrides of refused) {
      expect(prunableSingleTermList(paramsFor(overrides), index, FIELD_NAMES)).toBeNull()
    }
    expect(prunableSingleTermList(paramsFor({ exact: true, tolerance: 1 }), index, FIELD_NAMES)).not.toBeNull()
    expect(prunableSingleTermList(paramsFor({ fields: ['title'] }), index, FIELD_NAMES)).not.toBeNull()
  })

  it('refuses a list whose entries fell out of document order', () => {
    const index = buildIndex(5)
    index.insert('alpha', 2, 1, 0, null)
    const list = index.lookup('alpha')
    expect(list?.ordered).toBe(false)
    expect(prunableSingleTermList(paramsFor(), index, FIELD_NAMES)).toBeNull()
  })
})

describe('routing to the pruned multi-term scan', () => {
  function twoTermIndex(alphaPostings: number, betaPostings: number) {
    const index = buildIndex(alphaPostings)
    for (let internalId = 0; internalId < betaPostings; internalId++) {
      index.insert('beta', internalId, 1, 0, null)
    }
    return index
  }

  const twoTerms = paramsFor({
    queryTokens: [
      { token: 'alpha', position: 0 },
      { token: 'beta', position: 1 },
    ],
  })

  it('routes a query to the pruned scan only once its lists together reach the posting threshold', () => {
    const half = MULTI_TERM_PRUNING_POSTINGS_THRESHOLD / 2
    expect(prunableMultiTermLists(twoTerms, twoTermIndex(half, half - 1))).toBeNull()
    const terms = prunableMultiTermLists(twoTerms, twoTermIndex(half, half))
    expect(terms?.map(term => term.token)).toEqual(['alpha', 'beta'])
  })
})
