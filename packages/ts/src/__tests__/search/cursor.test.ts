import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { decodePageCursor, encodePageCursor, sortSignatureOf } from '../../search/cursor'

function encodeRaw(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

function expectInvalidCursor(encoded: string): void {
  expect(() => decodePageCursor(encoded)).toThrow(NarsilError)
  try {
    decodePageCursor(encoded)
  } catch (e) {
    expect((e as NarsilError).code).toBe(ErrorCodes.SEARCH_INVALID_CURSOR)
  }
}

describe('page cursor', () => {
  it('round-trips a score cursor', () => {
    const cursor = { anchor: 'doc-42', score: 4.523, sortKey: null, sortSignature: null }
    expect(decodePageCursor(encodePageCursor(cursor))).toEqual(cursor)
  })

  it('round-trips a sorted cursor', () => {
    const cursor = {
      anchor: 'doc-42',
      score: null,
      sortKey: ['Widget', 42, true, null],
      sortSignature: '[["title","asc"],["price","desc"]]',
    }
    expect(decodePageCursor(encodePageCursor(cursor))).toEqual(cursor)
  })

  it('round-trips an anchor-only cursor', () => {
    const cursor = { anchor: 'doc-42', score: null, sortKey: null, sortSignature: null }
    expect(decodePageCursor(encodePageCursor(cursor))).toEqual(cursor)
  })

  it('rejects invalid base64, invalid JSON, and a non-object payload', () => {
    expectInvalidCursor('!!!not-base64!!!')
    expectInvalidCursor(Buffer.from('{"v":2,"a"').toString('base64'))
    expectInvalidCursor(encodeRaw([{ v: 2, a: 'doc-1' }]))
  })

  it('rejects any version other than 2', () => {
    expectInvalidCursor(encodeRaw({ v: 1, a: 'doc-1', s: 1 }))
    expectInvalidCursor(encodeRaw({ v: 3, a: 'doc-1', s: 1 }))
    expectInvalidCursor(encodeRaw({ a: 'doc-1', s: 1 }))
  })

  it('rejects a missing, empty, or oversized anchor', () => {
    expectInvalidCursor(encodeRaw({ v: 2, s: 1 }))
    expectInvalidCursor(encodeRaw({ v: 2, a: '', s: 1 }))
    expectInvalidCursor(encodeRaw({ v: 2, a: 'x'.repeat(513), s: 1 }))
  })

  it('accepts an anchor of 512 supplementary characters, which exceed 512 UTF-16 units', () => {
    const anchor = String.fromCodePoint(0x1f600).repeat(512)
    const decoded = decodePageCursor(encodeRaw({ v: 2, a: anchor, s: 1 }))
    expect(decoded.anchor).toBe(anchor)
  })

  it('rejects a non-finite score', () => {
    expectInvalidCursor(encodeRaw({ v: 2, a: 'doc-1', s: 'high' }))
    expectInvalidCursor(Buffer.from('{"v":2,"a":"doc-1","s":1e999}').toString('base64'))
  })

  it('rejects a cursor carrying both a score and a sort key', () => {
    expectInvalidCursor(encodeRaw({ v: 2, a: 'doc-1', s: 1, k: ['x'], o: '[["f","asc"]]' }))
  })

  it('rejects a sort key without its sort order, and the reverse', () => {
    expectInvalidCursor(encodeRaw({ v: 2, a: 'doc-1', k: ['x'] }))
    expectInvalidCursor(encodeRaw({ v: 2, a: 'doc-1', o: '[["f","asc"]]' }))
  })

  it('rejects a sort key holding more than 8 values or a disallowed value', () => {
    const order = '[["f","asc"]]'
    expectInvalidCursor(encodeRaw({ v: 2, a: 'doc-1', k: Array.from({ length: 9 }, () => 1), o: order }))
    expectInvalidCursor(encodeRaw({ v: 2, a: 'doc-1', k: [{ nested: true }], o: order }))
    expectInvalidCursor(encodeRaw({ v: 2, a: 'doc-1', k: ['x'.repeat(513)], o: order }))
    expectInvalidCursor(Buffer.from('{"v":2,"a":"doc-1","k":[1e999],"o":"[[\\"f\\",\\"asc\\"]]"}').toString('base64'))
  })

  it('rejects a cursor longer than 8192 characters', () => {
    expectInvalidCursor('A'.repeat(8193))
  })

  it('builds the sort signature the sorted cursor carries', () => {
    expect(sortSignatureOf(undefined)).toBeNull()
    expect(sortSignatureOf({})).toBeNull()
    expect(sortSignatureOf({ title: 'asc', price: 'desc' })).toBe('[["title","asc"],["price","desc"]]')
  })

  it('rejects a sort naming more than 8 fields with SEARCH_INVALID_FIELD', () => {
    const sort: Record<string, 'asc'> = {}
    for (let i = 0; i < 9; i++) sort[`field${i}`] = 'asc'
    try {
      sortSignatureOf(sort)
      expect.unreachable()
    } catch (e) {
      expect((e as NarsilError).code).toBe(ErrorCodes.SEARCH_INVALID_FIELD)
    }
  })
})
