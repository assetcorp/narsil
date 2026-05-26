import { describe, expect, it } from 'vitest'
import {
  MAX_VECTOR_DIMENSION,
  MAX_VECTOR_TEXT_LENGTH,
  validateSearchPayload,
} from '../../../../distribution/query/codec'
import type { WireVectorQueryParams } from '../../../../distribution/transport/types'

function makeSearchPayload(vector: WireVectorQueryParams | unknown | null): Record<string, unknown> {
  return {
    indexName: 'products',
    partitionIds: [0],
    params: {
      term: null,
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
      scoring: 'local',
      vector,
      hybrid: null,
    },
    globalStats: null,
    facetShardSize: null,
  }
}

describe('validateSearchPayload vector substructure', () => {
  it('accepts a null vector substructure', () => {
    const result = validateSearchPayload(makeSearchPayload(null))
    expect(result.params.vector).toBeNull()
  })

  it('accepts a well-formed vector with value, text, and similarity', () => {
    const result = validateSearchPayload(
      makeSearchPayload({
        field: 'embedding',
        value: [0.1, 0.2, 0.3],
        text: 'red running shoes',
        similarity: 0.7,
      }),
    )
    expect(result.params.vector).not.toBeNull()
  })

  it('rejects vector substructure that is not an object', () => {
    expect(() => validateSearchPayload(makeSearchPayload('not-an-object' as unknown as WireVectorQueryParams))).toThrow(
      /params\.vector/,
    )
  })

  it('rejects vector substructure with an empty field name', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ field: '', value: null, text: null, similarity: null })),
    ).toThrow(/params\.vector\.field/)
  })

  it('rejects vector substructure with a non-string field', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({ field: 42 as unknown as string, value: null, text: null, similarity: null }),
      ),
    ).toThrow(/params\.vector\.field/)
  })

  it('rejects similarity that is a string', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({
          field: 'embedding',
          value: null,
          text: null,
          similarity: '0.5' as unknown as number,
        }),
      ),
    ).toThrow(/params\.vector\.similarity/)
  })

  it('rejects similarity that is NaN', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ field: 'embedding', value: null, text: null, similarity: Number.NaN })),
    ).toThrow(/params\.vector\.similarity/)
  })

  it('rejects similarity that is Infinity', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({ field: 'embedding', value: null, text: null, similarity: Number.POSITIVE_INFINITY }),
      ),
    ).toThrow(/params\.vector\.similarity/)
  })

  it('rejects similarity that is an object', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({
          field: 'embedding',
          value: null,
          text: null,
          similarity: { malicious: true } as unknown as number,
        }),
      ),
    ).toThrow(/params\.vector\.similarity/)
  })

  it('rejects value that is a string instead of an array', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({
          field: 'embedding',
          value: 'not-an-array' as unknown as number[],
          text: null,
          similarity: null,
        }),
      ),
    ).toThrow(/params\.vector\.value/)
  })

  it('rejects an empty value array', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ field: 'embedding', value: [], text: null, similarity: null })),
    ).toThrow(/params\.vector\.value/)
  })

  it('rejects a value array exceeding the dimension limit', () => {
    const oversized = new Array(MAX_VECTOR_DIMENSION + 1).fill(0.1)
    expect(() =>
      validateSearchPayload(makeSearchPayload({ field: 'embedding', value: oversized, text: null, similarity: null })),
    ).toThrow(/params\.vector\.value/)
  })

  it('rejects a value array containing NaN', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({ field: 'embedding', value: [0.1, Number.NaN, 0.3], text: null, similarity: null }),
      ),
    ).toThrow(/params\.vector\.value\[1\]/)
  })

  it('rejects a value array containing Infinity', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({
          field: 'embedding',
          value: [0.1, Number.POSITIVE_INFINITY],
          text: null,
          similarity: null,
        }),
      ),
    ).toThrow(/params\.vector\.value\[1\]/)
  })

  it('rejects a value array containing a string component', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({
          field: 'embedding',
          value: [0.1, '0.2' as unknown as number, 0.3],
          text: null,
          similarity: null,
        }),
      ),
    ).toThrow(/params\.vector\.value\[1\]/)
  })

  it('rejects text that is a number', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({
          field: 'embedding',
          value: null,
          text: 123 as unknown as string,
          similarity: null,
        }),
      ),
    ).toThrow(/params\.vector\.text/)
  })

  it('rejects text exceeding the length limit', () => {
    const huge = 'a'.repeat(MAX_VECTOR_TEXT_LENGTH + 1)
    expect(() =>
      validateSearchPayload(makeSearchPayload({ field: 'embedding', value: null, text: huge, similarity: null })),
    ).toThrow(/params\.vector\.text/)
  })

  it('accepts a value array exactly at the dimension limit', () => {
    const sized = new Array(MAX_VECTOR_DIMENSION).fill(0.1)
    const result = validateSearchPayload(
      makeSearchPayload({ field: 'embedding', value: sized, text: null, similarity: null }),
    )
    expect(result.params.vector?.value).toHaveLength(MAX_VECTOR_DIMENSION)
  })

  it('accepts text exactly at the length limit', () => {
    const sized = 'a'.repeat(MAX_VECTOR_TEXT_LENGTH)
    const result = validateSearchPayload(
      makeSearchPayload({ field: 'embedding', value: null, text: sized, similarity: null }),
    )
    expect(result.params.vector?.text).toHaveLength(MAX_VECTOR_TEXT_LENGTH)
  })
})
