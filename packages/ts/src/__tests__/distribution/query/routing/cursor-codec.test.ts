import { describe, expect, it } from 'vitest'
import { decodeDistributedCursor, encodeDistributedCursor } from '../../../../distribution/query/cursor'
import { NarsilError } from '../../../../errors'

describe('distributed cursor encode/decode', () => {
  it('round-trips score and docId through encode and decode', () => {
    const encoded = encodeDistributedCursor(4.523, 'doc-id-123')
    const decoded = decodeDistributedCursor(encoded)
    expect(decoded.s).toBe(4.523)
    expect(decoded.d).toBe('doc-id-123')
  })

  it('handles zero score', () => {
    const encoded = encodeDistributedCursor(0, 'doc-zero')
    const decoded = decodeDistributedCursor(encoded)
    expect(decoded.s).toBe(0)
    expect(decoded.d).toBe('doc-zero')
  })

  it('handles negative score', () => {
    const encoded = encodeDistributedCursor(-3.14, 'doc-neg')
    const decoded = decodeDistributedCursor(encoded)
    expect(decoded.s).toBe(-3.14)
    expect(decoded.d).toBe('doc-neg')
  })

  it('handles special characters in docId', () => {
    const encoded = encodeDistributedCursor(1.0, 'doc/with"special\\chars')
    const decoded = decodeDistributedCursor(encoded)
    expect(decoded.d).toBe('doc/with"special\\chars')
  })

  it('rejects invalid base64', () => {
    let error: unknown
    try {
      decodeDistributedCursor('not-valid-base64!!!')
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects valid base64 with invalid JSON', () => {
    const badJson = Buffer.from('not json at all').toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(badJson)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects a JSON array instead of an object', () => {
    const arrayJson = Buffer.from(JSON.stringify([1, 2, 3])).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(arrayJson)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects missing "s" field', () => {
    const noScore = Buffer.from(JSON.stringify({ d: 'doc-1' })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(noScore)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects missing "d" field', () => {
    const noDocId = Buffer.from(JSON.stringify({ s: 5.0 })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(noDocId)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects non-finite score (Infinity)', () => {
    const infScore = Buffer.from(JSON.stringify({ s: 'Infinity', d: 'doc-1' })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(infScore)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects non-finite score (NaN)', () => {
    const nanCursor = Buffer.from(JSON.stringify({ s: 'NaN', d: 'doc-1' })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(nanCursor)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects null score', () => {
    const nullScore = Buffer.from(JSON.stringify({ s: null, d: 'doc-1' })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(nullScore)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects empty string docId', () => {
    const emptyDocId = Buffer.from(JSON.stringify({ s: 5.0, d: '' })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(emptyDocId)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects numeric docId', () => {
    const numericDocId = Buffer.from(JSON.stringify({ s: 5.0, d: 42 })).toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(numericDocId)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })

  it('rejects null as the top-level value', () => {
    const nullCursor = Buffer.from('null').toString('base64')
    let error: unknown
    try {
      decodeDistributedCursor(nullCursor)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(NarsilError)
    expect((error as NarsilError).code).toBe('SEARCH_INVALID_CURSOR')
  })
})
