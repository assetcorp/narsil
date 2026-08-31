import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import {
  validateCountPayload,
  validateCountResultPayload,
  validateListPayload,
  validateListResultPayload,
  validatePreflightPayload,
  validatePreflightResultPayload,
  validateSuggestPayload,
  validateSuggestResultPayload,
} from '../../../distribution/query/codec'
import type {
  CountPayload,
  CountResultPayload,
  ListPayload,
  ListResultPayload,
  PreflightResultPayload,
  SuggestPayload,
  SuggestResultPayload,
  WireQueryParams,
} from '../../../distribution/transport/types'

function roundTrip<T>(payload: T): unknown {
  return decode(encode(payload))
}

function wireParams(): WireQueryParams {
  return {
    term: 'kettle',
    filters: null,
    sort: null,
    group: null,
    facets: null,
    facetSize: null,
    limit: 10,
    offset: 0,
    searchAfter: null,
    fields: null,
    boost: null,
    tolerance: null,
    threshold: null,
    includeScores: null,
    scoring: 'local',
    termMatch: null,
    prefixLength: null,
    prefix: null,
    exact: null,
    pinned: null,
    mode: null,
    vector: null,
    hybrid: null,
  }
}

describe('count payload validation', () => {
  it('round-trips a valid payload and result', () => {
    const payload: CountPayload = { indexName: 'products', partitionIds: [0, 2] }
    expect(validateCountPayload(roundTrip(payload))).toEqual(payload)

    const result: CountResultPayload = {
      partitions: [{ partitionId: 0, documentCount: 5, estimatedMemoryBytes: 1_024 }],
      language: 'english',
    }
    expect(validateCountResultPayload(roundTrip(result))).toEqual(result)
  })

  it('rejects a payload without partition ids and a result with a negative count', () => {
    expect(() => validateCountPayload({ indexName: 'products', partitionIds: 'all' })).toThrow('must be an array')
    expect(() =>
      validateCountResultPayload({
        partitions: [{ partitionId: 0, documentCount: -1, estimatedMemoryBytes: 0 }],
        language: 'english',
      }),
    ).toThrow('non-negative')
  })
})

describe('list payload validation', () => {
  function listPayload(): ListPayload {
    return {
      indexName: 'products',
      partitionIds: [1],
      cursor: null,
      limit: 25,
      filters: { fields: { category: { eq: 'audio' } } },
      sort: [{ field: 'price', direction: 'desc' }],
      fields: ['title'],
    }
  }

  it('round-trips a valid payload and result', () => {
    expect(validateListPayload(roundTrip(listPayload()))).toEqual(listPayload())

    const result: ListResultPayload = {
      entries: [{ docId: 'doc-1', document: { title: 'Kettle' }, sortValues: [12] }],
      total: 40,
      hasMore: true,
    }
    expect(validateListResultPayload(roundTrip(result))).toEqual(result)
  })

  it('rejects a zero limit, a bad sort direction, and a non-scalar sort value', () => {
    expect(() => validateListPayload(roundTrip({ ...listPayload(), limit: 0 }))).toThrow('positive integer')
    const badSort = { ...listPayload(), sort: [{ field: 'price', direction: 'down' }] }
    expect(() => validateListPayload(roundTrip(badSort))).toThrow('"asc" or "desc"')
    expect(() =>
      validateListResultPayload({
        entries: [{ docId: 'doc-1', document: {}, sortValues: [{ nested: true }] }],
        total: 1,
        hasMore: false,
      }),
    ).toThrow('scalar')
  })
})

describe('suggest payload validation', () => {
  it('round-trips a valid payload and result', () => {
    const payload: SuggestPayload = { indexName: 'products', partitionIds: [0], prefix: 'ket', limit: 25 }
    expect(validateSuggestPayload(roundTrip(payload))).toEqual(payload)

    const result: SuggestResultPayload = {
      terms: [{ term: 'kettle', documentFrequency: 9 }],
      analysisStale: false,
    }
    expect(validateSuggestResultPayload(roundTrip(result))).toEqual(result)
  })

  it('rejects an empty prefix and an oversized limit', () => {
    expect(() => validateSuggestPayload({ indexName: 'products', partitionIds: [0], prefix: '', limit: 10 })).toThrow(
      'non-empty',
    )
    expect(() =>
      validateSuggestPayload({ indexName: 'products', partitionIds: [0], prefix: 'ket', limit: 10_000 }),
    ).toThrow('exceeds maximum value')
  })
})

describe('preflight payload validation', () => {
  it('round-trips a valid payload and result', () => {
    const payload = { indexName: 'products', partitionIds: [0, 1], params: wireParams() }
    const validated = validatePreflightPayload(roundTrip(payload))
    expect(validated.indexName).toBe('products')
    expect(validated.params.term).toBe('kettle')

    const result: PreflightResultPayload = { count: 3, analysisStale: false }
    expect(validatePreflightResultPayload(roundTrip(result))).toEqual(result)
  })

  it('rejects missing params and a fractional count', () => {
    expect(() => validatePreflightPayload({ indexName: 'products', partitionIds: [0], params: null })).toThrow(
      'must be an object',
    )
    expect(() => validatePreflightResultPayload({ count: 1.5, analysisStale: false })).toThrow('non-negative integer')
  })
})
