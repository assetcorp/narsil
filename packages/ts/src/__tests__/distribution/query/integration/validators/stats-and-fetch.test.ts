import { describe, expect, it } from 'vitest'
import {
  validateFetchPayload,
  validateFetchResultPayload,
  validateGlobalStatistics,
  validateStatsPayload,
  validateStatsResultPayload,
} from '../../../../../distribution/query/codec'
import {
  MAX_DOC_ID_LENGTH,
  MAX_FETCH_DOCUMENT_IDS,
  MAX_FIELDS_LIST,
  MAX_PARTITION_COUNT,
  MAX_TERM_LENGTH,
  MAX_TERMS_COUNT,
} from '../../../../../distribution/query/validators/common'
import { NarsilError } from '../../../../../errors'

describe('validateStatsPayload', () => {
  function makeStatsPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      indexName: 'products',
      partitionIds: [0],
      terms: ['hello', 'world'],
      ...overrides,
    }
  }

  it('throws NarsilError when payload is not an object', () => {
    expect(() => validateStatsPayload(null)).toThrow(NarsilError)
  })

  it('rejects malformed indexName', () => {
    expect(() => validateStatsPayload(makeStatsPayload({ indexName: '../escape' }))).toThrow(NarsilError)
  })

  it('rejects fractional partitionId', () => {
    expect(() => validateStatsPayload(makeStatsPayload({ partitionIds: [1.5] }))).toThrow(/partitionIds/)
  })

  it('rejects partitionId at MAX_PARTITION_COUNT', () => {
    expect(() => validateStatsPayload(makeStatsPayload({ partitionIds: [MAX_PARTITION_COUNT] }))).toThrow(
      /partitionIds/,
    )
  })

  it('rejects terms exceeding MAX_TERMS_COUNT', () => {
    const oversized = Array.from({ length: MAX_TERMS_COUNT + 1 }, (_, i) => `t${i}`)
    expect(() => validateStatsPayload(makeStatsPayload({ terms: oversized }))).toThrow(/terms/)
  })

  it('rejects terms with non-string entry', () => {
    expect(() => validateStatsPayload(makeStatsPayload({ terms: ['ok', 42] }))).toThrow(/terms/)
  })

  it('rejects terms with overlong string', () => {
    expect(() => validateStatsPayload(makeStatsPayload({ terms: ['a'.repeat(MAX_TERM_LENGTH + 1)] }))).toThrow(/terms/)
  })

  it('accepts a well-formed payload', () => {
    expect(() => validateStatsPayload(makeStatsPayload())).not.toThrow()
  })
})

describe('validateStatsResultPayload', () => {
  it('throws NarsilError when payload is not an object', () => {
    expect(() => validateStatsResultPayload('oops')).toThrow(NarsilError)
  })

  it('rejects negative totalDocuments', () => {
    expect(() => validateStatsResultPayload({ totalDocuments: -1, docFrequencies: {}, totalFieldLengths: {} })).toThrow(
      /totalDocuments/,
    )
  })

  it('rejects docFrequencies that is not an object', () => {
    expect(() => validateStatsResultPayload({ totalDocuments: 0, docFrequencies: [], totalFieldLengths: {} })).toThrow(
      /docFrequencies/,
    )
  })

  it('rejects docFrequencies with negative value', () => {
    expect(() =>
      validateStatsResultPayload({ totalDocuments: 0, docFrequencies: { term: -1 }, totalFieldLengths: {} }),
    ).toThrow(/docFrequencies/)
  })

  it('accepts a well-formed payload', () => {
    expect(() =>
      validateStatsResultPayload({
        totalDocuments: 100,
        docFrequencies: { hello: 5 },
        totalFieldLengths: { title: 250 },
      }),
    ).not.toThrow()
  })
})

describe('validateGlobalStatistics', () => {
  it('throws NarsilError when value is not an object', () => {
    expect(() => validateGlobalStatistics('oops')).toThrow(NarsilError)
  })

  it('rejects non-finite totalDocuments', () => {
    expect(() =>
      validateGlobalStatistics({
        totalDocuments: Number.POSITIVE_INFINITY,
        docFrequencies: {},
        totalFieldLengths: {},
        averageFieldLengths: {},
      }),
    ).toThrow(/totalDocuments/)
  })

  it('rejects averageFieldLengths that is missing', () => {
    expect(() =>
      validateGlobalStatistics({
        totalDocuments: 5,
        docFrequencies: {},
        totalFieldLengths: {},
      }),
    ).toThrow(/averageFieldLengths/)
  })

  it('accepts a well-formed payload', () => {
    expect(() =>
      validateGlobalStatistics({
        totalDocuments: 100,
        docFrequencies: { hello: 5 },
        totalFieldLengths: { title: 250 },
        averageFieldLengths: { title: 2.5 },
      }),
    ).not.toThrow()
  })
})

describe('validateFetchPayload', () => {
  function makeFetchPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      indexName: 'products',
      documentIds: [{ docId: 'doc-1', partitionId: 0 }],
      fields: null,
      highlight: null,
      ...overrides,
    }
  }

  it('throws NarsilError when payload is not an object', () => {
    expect(() => validateFetchPayload('oops')).toThrow(NarsilError)
  })

  it('rejects malformed indexName', () => {
    expect(() => validateFetchPayload(makeFetchPayload({ indexName: '/escape' }))).toThrow(NarsilError)
  })

  it('rejects documentIds entry without docId', () => {
    expect(() => validateFetchPayload(makeFetchPayload({ documentIds: [{ partitionId: 0 }] }))).toThrow(/docId/)
  })

  it('rejects documentIds entry with empty docId', () => {
    expect(() => validateFetchPayload(makeFetchPayload({ documentIds: [{ docId: '', partitionId: 0 }] }))).toThrow(
      /docId/,
    )
  })

  it('rejects documentIds entry with overlong docId', () => {
    expect(() =>
      validateFetchPayload(
        makeFetchPayload({ documentIds: [{ docId: 'a'.repeat(MAX_DOC_ID_LENGTH + 1), partitionId: 0 }] }),
      ),
    ).toThrow(/docId/)
  })

  it('rejects documentIds entry with fractional partitionId', () => {
    expect(() => validateFetchPayload(makeFetchPayload({ documentIds: [{ docId: 'doc', partitionId: 1.5 }] }))).toThrow(
      /partitionId/,
    )
  })

  it('rejects documentIds exceeding MAX_FETCH_DOCUMENT_IDS', () => {
    const oversized = Array.from({ length: MAX_FETCH_DOCUMENT_IDS + 1 }, (_, i) => ({
      docId: `d${i}`,
      partitionId: 0,
    }))
    expect(() => validateFetchPayload(makeFetchPayload({ documentIds: oversized }))).toThrow(/documentIds/)
  })

  it('rejects fields with non-string entry', () => {
    expect(() => validateFetchPayload(makeFetchPayload({ fields: [42] }))).toThrow(/fields/)
  })

  it('rejects fields exceeding MAX_FIELDS_LIST', () => {
    const oversized = Array.from({ length: MAX_FIELDS_LIST + 1 }, (_, i) => `f${i}`)
    expect(() => validateFetchPayload(makeFetchPayload({ fields: oversized }))).toThrow(/fields/)
  })

  it('rejects highlight that is not an object', () => {
    expect(() => validateFetchPayload(makeFetchPayload({ highlight: 'oops' }))).toThrow(/highlight/)
  })

  it('rejects highlight with maxSnippetLength that is zero', () => {
    expect(() =>
      validateFetchPayload(
        makeFetchPayload({
          highlight: { fields: null, before: '<em>', after: '</em>', maxSnippetLength: 0 },
        }),
      ),
    ).toThrow(/maxSnippetLength/)
  })

  it('accepts a well-formed payload with highlight', () => {
    expect(() =>
      validateFetchPayload(
        makeFetchPayload({
          highlight: { fields: ['title'], before: '<em>', after: '</em>', maxSnippetLength: 200 },
        }),
      ),
    ).not.toThrow()
  })
})

describe('validateFetchResultPayload', () => {
  it('throws NarsilError when payload is not an object', () => {
    expect(() => validateFetchResultPayload('oops')).toThrow(NarsilError)
  })

  it('rejects documents entry that is not an object', () => {
    expect(() => validateFetchResultPayload({ documents: ['oops'] })).toThrow(NarsilError)
  })

  it('rejects documents entry with non-string docId', () => {
    expect(() => validateFetchResultPayload({ documents: [{ docId: 42, document: {}, highlights: null }] })).toThrow(
      /docId/,
    )
  })

  it('rejects documents entry with non-object document', () => {
    expect(() =>
      validateFetchResultPayload({ documents: [{ docId: 'doc-1', document: 'oops', highlights: null }] }),
    ).toThrow(/document/)
  })

  it('accepts a well-formed payload', () => {
    expect(() =>
      validateFetchResultPayload({
        documents: [{ docId: 'doc-1', document: { title: 'hello' }, highlights: null }],
      }),
    ).not.toThrow()
  })
})
