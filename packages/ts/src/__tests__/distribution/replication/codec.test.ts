import { describe, expect, it } from 'vitest'
import {
  validateAckPayload,
  validateEntryPayload,
  validateInsyncConfirmPayload,
} from '../../../distribution/replication/codec'

describe('validateEntryPayload', () => {
  const validEntry = {
    entry: {
      seqNo: 1,
      primaryTerm: 1,
      operation: 'INDEX' as const,
      partitionId: 0,
      indexName: 'products',
      documentId: 'doc-001',
      document: new Uint8Array([1, 2, 3]),
      checksum: 12345,
    },
  }

  it('accepts a valid EntryPayload with Uint8Array document', () => {
    const result = validateEntryPayload(validEntry)
    expect(result.entry.seqNo).toBe(1)
    expect(result.entry.documentId).toBe('doc-001')
  })

  it('accepts a valid EntryPayload with null document', () => {
    const payload = { entry: { ...validEntry.entry, document: null } }
    const result = validateEntryPayload(payload)
    expect(result.entry.document).toBeNull()
  })

  it('rejects non-object input', () => {
    expect(() => validateEntryPayload('not an object')).toThrow('missing or invalid "entry" field')
    expect(() => validateEntryPayload(null)).toThrow('missing or invalid "entry" field')
    expect(() => validateEntryPayload(42)).toThrow('missing or invalid "entry" field')
  })

  it('rejects when entry field is missing', () => {
    expect(() => validateEntryPayload({})).toThrow('missing or invalid "entry" field')
  })

  it('rejects when entry.seqNo is not a number', () => {
    const payload = { entry: { ...validEntry.entry, seqNo: 'abc' } }
    expect(() => validateEntryPayload(payload)).toThrow('"entry.seqNo" must be a number')
  })

  it('rejects when entry.primaryTerm is not a number', () => {
    const payload = { entry: { ...validEntry.entry, primaryTerm: true } }
    expect(() => validateEntryPayload(payload)).toThrow('"entry.primaryTerm" must be a number')
  })

  it('rejects when entry.operation is not INDEX or DELETE', () => {
    const payload = { entry: { ...validEntry.entry, operation: 'UPDATE' } }
    expect(() => validateEntryPayload(payload)).toThrow('"entry.operation" must be "INDEX" or "DELETE"')
  })

  it('rejects when entry.partitionId is not a number', () => {
    const payload = { entry: { ...validEntry.entry, partitionId: 'zero' } }
    expect(() => validateEntryPayload(payload)).toThrow('"entry.partitionId" must be a number')
  })

  it('rejects when entry.indexName is not a string', () => {
    const payload = { entry: { ...validEntry.entry, indexName: 123 } }
    expect(() => validateEntryPayload(payload)).toThrow('"entry.indexName" must be a string')
  })

  it('rejects when entry.documentId is not a string', () => {
    const payload = { entry: { ...validEntry.entry, documentId: null } }
    expect(() => validateEntryPayload(payload)).toThrow('"entry.documentId" must be a string')
  })

  it('rejects when entry.document is not Uint8Array or null', () => {
    const payload = { entry: { ...validEntry.entry, document: 'string-data' } }
    expect(() => validateEntryPayload(payload)).toThrow('"entry.document" must be Uint8Array or null')
  })

  it('rejects when entry.checksum is not a number', () => {
    const payload = { entry: { ...validEntry.entry, checksum: undefined } }
    expect(() => validateEntryPayload(payload)).toThrow('"entry.checksum" must be a number')
  })
})

describe('validateInsyncConfirmPayload', () => {
  it('accepts a valid InsyncConfirmPayload', () => {
    const payload = { indexName: 'products', partitionId: 0, accepted: true }
    const result = validateInsyncConfirmPayload(payload)
    expect(result.indexName).toBe('products')
    expect(result.accepted).toBe(true)
  })

  it('rejects non-object input', () => {
    expect(() => validateInsyncConfirmPayload(null)).toThrow('expected an object')
    expect(() => validateInsyncConfirmPayload([])).toThrow('expected an object')
  })

  it('rejects when indexName is not a string', () => {
    expect(() => validateInsyncConfirmPayload({ indexName: 0, partitionId: 0, accepted: true })).toThrow(
      '"indexName" must be a string',
    )
  })

  it('rejects when partitionId is not a number', () => {
    expect(() => validateInsyncConfirmPayload({ indexName: 'x', partitionId: 'a', accepted: true })).toThrow(
      '"partitionId" must be a number',
    )
  })

  it('rejects when accepted is not a boolean', () => {
    expect(() => validateInsyncConfirmPayload({ indexName: 'x', partitionId: 0, accepted: 'yes' })).toThrow(
      '"accepted" must be a boolean',
    )
  })
})

describe('validateAckPayload', () => {
  it('accepts a valid AckPayload', () => {
    const payload = { seqNo: 5, partitionId: 0, indexName: 'products' }
    const result = validateAckPayload(payload)
    expect(result.seqNo).toBe(5)
    expect(result.indexName).toBe('products')
  })

  it('rejects non-object input', () => {
    expect(() => validateAckPayload(undefined)).toThrow('expected an object')
    expect(() => validateAckPayload(123)).toThrow('expected an object')
  })

  it('rejects when seqNo is not a number', () => {
    expect(() => validateAckPayload({ seqNo: 'one', partitionId: 0, indexName: 'x' })).toThrow(
      '"seqNo" must be a number',
    )
  })

  it('rejects when partitionId is not a number', () => {
    expect(() => validateAckPayload({ seqNo: 1, partitionId: null, indexName: 'x' })).toThrow(
      '"partitionId" must be a number',
    )
  })

  it('rejects when indexName is not a string', () => {
    expect(() => validateAckPayload({ seqNo: 1, partitionId: 0, indexName: false })).toThrow(
      '"indexName" must be a string',
    )
  })
})
