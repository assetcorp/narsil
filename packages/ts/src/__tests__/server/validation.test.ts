import { describe, expect, it } from 'vitest'
import type { BatchBody, CreateIndexRequest, MultiGetBody, RebalanceBody } from '../../server/types'
import {
  validateBatch,
  validateCreateIndex,
  validateDocumentBody,
  validateMultiGet,
  validateQuery,
  validateRebalance,
  validateSuggest,
} from '../../server/validation'
import type { QueryParams } from '../../types/search'

const WINDOW = 100
const FETCH = 50

describe('validateQuery bounds every result-amplifying field', () => {
  it('accepts a query within the window', () => {
    const params: QueryParams = { term: 'x', limit: 100, offset: 100 }
    expect(validateQuery(params, WINDOW)).toBeNull()
  })

  it('rejects limit above the window', () => {
    const failure = validateQuery({ limit: 101 }, WINDOW)
    expect(failure?.details).toMatchObject({ value: 101, limit: WINDOW })
  })

  it('rejects offset above the window', () => {
    expect(validateQuery({ offset: 101 }, WINDOW)).not.toBeNull()
  })

  it('rejects group.maxPerGroup above the window', () => {
    expect(validateQuery({ group: { fields: ['a'], maxPerGroup: 101 } }, WINDOW)).not.toBeNull()
  })

  it('rejects a facet limit above the window', () => {
    expect(validateQuery({ facets: { author: { limit: 101 } } }, WINDOW)).not.toBeNull()
  })

  it('rejects a custom group reducer', () => {
    const group = { fields: ['a'], reduce: { reducer: () => 0, initialValue: () => 0 } }
    expect(validateQuery({ group } as unknown as QueryParams, WINDOW)).not.toBeNull()
  })

  it('ignores non-numeric field values and defers to the engine', () => {
    expect(validateQuery({ limit: undefined, offset: undefined }, WINDOW)).toBeNull()
  })
})

describe('validateMultiGet', () => {
  it('requires an array', () => {
    expect(validateMultiGet({ docIds: 'nope' } as unknown as MultiGetBody, FETCH)).not.toBeNull()
  })

  it('rejects more ids than the fetch limit', () => {
    const docIds = Array.from({ length: FETCH + 1 }, (_, i) => `id-${i}`)
    const failure = validateMultiGet({ docIds }, FETCH)
    expect(failure?.details).toMatchObject({ count: FETCH + 1, limit: FETCH })
  })

  it('accepts a request at the fetch boundary', () => {
    const docIds = Array.from({ length: FETCH }, (_, i) => `id-${i}`)
    expect(validateMultiGet({ docIds }, FETCH)).toBeNull()
  })
})

describe('validateBatch', () => {
  it('requires a documents array for insert', () => {
    expect(validateBatch({ action: 'insert' })).not.toBeNull()
    expect(validateBatch({ documents: [] })).toBeNull()
  })

  it('requires an updates array for update', () => {
    expect(validateBatch({ action: 'update' })).not.toBeNull()
    expect(validateBatch({ action: 'update', updates: [] })).toBeNull()
  })

  it('requires a docIds array for delete', () => {
    expect(validateBatch({ action: 'delete' })).not.toBeNull()
    expect(validateBatch({ action: 'delete', docIds: [] })).toBeNull()
  })

  it('rejects an unknown action', () => {
    expect(validateBatch({ action: 'purge' } as unknown as BatchBody)).not.toBeNull()
  })
})

describe('validateDocumentBody', () => {
  it('rejects a non-object document', () => {
    expect(validateDocumentBody({ document: 'x' } as never)).not.toBeNull()
    expect(validateDocumentBody({ document: [] } as never)).not.toBeNull()
  })

  it('accepts an object document', () => {
    expect(validateDocumentBody({ document: { title: 'ok' } })).toBeNull()
  })
})

describe('validateCreateIndex', () => {
  it('requires a non-empty name', () => {
    expect(validateCreateIndex({ name: '', config: { schema: {} } } as CreateIndexRequest)).not.toBeNull()
  })

  it('requires a config object', () => {
    expect(validateCreateIndex({ name: 'movies' } as CreateIndexRequest)).not.toBeNull()
  })

  it('accepts a well-formed request', () => {
    expect(validateCreateIndex({ name: 'movies', config: { schema: { title: 'string' } } })).toBeNull()
  })
})

describe('validateRebalance', () => {
  it('requires a positive integer', () => {
    expect(validateRebalance({ targetPartitionCount: 0 })).not.toBeNull()
    expect(validateRebalance({ targetPartitionCount: 1.5 })).not.toBeNull()
    expect(validateRebalance({} as RebalanceBody)).not.toBeNull()
  })

  it('accepts a positive integer', () => {
    expect(validateRebalance({ targetPartitionCount: 4 })).toBeNull()
  })
})

describe('validateSuggest', () => {
  it('requires a string prefix', () => {
    expect(validateSuggest({ prefix: 5 } as never)).not.toBeNull()
    expect(validateSuggest({ prefix: 'sec' })).toBeNull()
  })
})
