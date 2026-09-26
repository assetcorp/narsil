import { describe, expect, it } from 'vitest'
import { createNarsilError, ErrorCodes, NarsilError } from '../../errors'

describe('ErrorCodes', () => {
  it('names every code after itself, so a caught code reads as the constant', () => {
    for (const [name, value] of Object.entries(ErrorCodes)) {
      expect(value).toBe(name)
    }
  })

  it('carries the code and the details through to what a caller catches', () => {
    const thrown = new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'bad field', { field: 'price' })

    try {
      throw thrown
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
      expect((err as NarsilError).details).toEqual({ field: 'price' })
    }
  })

  it('has exactly 93 error codes', () => {
    expect(Object.keys(ErrorCodes)).toHaveLength(93)
  })

  it('has unique values for every code', () => {
    const values = Object.values(ErrorCodes)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('NarsilError', () => {
  it('extends Error', () => {
    const err = new NarsilError(ErrorCodes.DOC_NOT_FOUND, 'Document not found')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(NarsilError)
  })

  it('sets the name to NarsilError', () => {
    const err = new NarsilError(ErrorCodes.DOC_NOT_FOUND, 'Document not found')
    expect(err.name).toBe('NarsilError')
  })

  it('stores the error code', () => {
    const err = new NarsilError(ErrorCodes.SCHEMA_INVALID_TYPE, 'Invalid type for field "price"')
    expect(err.code).toBe('SCHEMA_INVALID_TYPE')
  })

  it('stores the error message', () => {
    const err = new NarsilError(ErrorCodes.INDEX_NOT_FOUND, 'Index "products" does not exist')
    expect(err.message).toBe('Index "products" does not exist')
  })

  it('stores details when provided', () => {
    const details = {
      field: 'price',
      expectedType: 'number',
      receivedType: 'string',
    }
    const err = new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Validation failed', details)
    expect(err.details).toEqual(details)
  })

  it('defaults details to empty object when omitted', () => {
    const err = new NarsilError(ErrorCodes.DOC_NOT_FOUND, 'Not found')
    expect(err.details).toEqual({})
  })

  it('has a usable stack trace', () => {
    const err = new NarsilError(ErrorCodes.DOC_NOT_FOUND, 'Not found')
    expect(err.stack).toBeDefined()
    expect(err.stack).toContain('NarsilError')
  })

  it('can be caught as an Error', () => {
    expect(() => {
      throw new NarsilError(ErrorCodes.WORKER_CRASHED, 'Worker terminated unexpectedly')
    }).toThrow(Error)
  })

  it('can be caught as a NarsilError', () => {
    expect(() => {
      throw new NarsilError(ErrorCodes.WORKER_CRASHED, 'Worker terminated unexpectedly')
    }).toThrow(NarsilError)
  })

  it('preserves details as a reference', () => {
    const details = { partitionId: 3 }
    const err = new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'Partition corrupted', details)
    expect(err.details).toBe(details)
  })
})

describe('createNarsilError', () => {
  it('returns a NarsilError instance', () => {
    const err = createNarsilError(ErrorCodes.DOC_NOT_FOUND, 'Not found')
    expect(err).toBeInstanceOf(NarsilError)
  })

  it('passes code, message, and details through', () => {
    const details = { docId: 'abc-123' }
    const err = createNarsilError(ErrorCodes.DOC_NOT_FOUND, 'Document "abc-123" not found', details)
    expect(err.code).toBe('DOC_NOT_FOUND')
    expect(err.message).toBe('Document "abc-123" not found')
    expect(err.details).toEqual(details)
  })

  it('defaults details to empty object when omitted', () => {
    const err = createNarsilError(ErrorCodes.INDEX_ALREADY_EXISTS, 'Index already exists')
    expect(err.details).toEqual({})
  })
})
