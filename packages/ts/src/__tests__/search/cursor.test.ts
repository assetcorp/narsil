import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { MAX_CURSOR_LENGTH } from '../../search/constants'
import { decodePageCursor, encodePageCursor, sortSignatureOf } from '../../search/cursor'

const binding = 'ab12cd34'

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
    const cursor = { anchor: 'doc-42', score: 4.523, sortKey: null, sortSignature: null, binding }
    expect(decodePageCursor(encodePageCursor(cursor))).toEqual(cursor)
  })

  it('round-trips a sorted cursor', () => {
    const cursor = {
      anchor: 'doc-42',
      score: null,
      sortKey: ['Widget', 42, true, null],
      sortSignature: '[["title","asc"],["price","desc"]]',
      binding,
    }
    expect(decodePageCursor(encodePageCursor(cursor))).toEqual(cursor)
  })

  it('round-trips an anchor-only cursor', () => {
    const cursor = { anchor: 'doc-42', score: null, sortKey: null, sortSignature: null, binding }
    expect(decodePageCursor(encodePageCursor(cursor))).toEqual(cursor)
  })

  it('rejects invalid base64, invalid JSON, and a non-object payload', () => {
    expectInvalidCursor('!!!not-base64!!!')
    expectInvalidCursor(Buffer.from('{"v":3,"a"').toString('base64'))
    expectInvalidCursor(encodeRaw([{ v: 3, a: 'doc-1' }]))
  })

  it('rejects any version other than 3', () => {
    expectInvalidCursor(encodeRaw({ v: 2, a: 'doc-1', s: 1, q: binding }))
    expectInvalidCursor(encodeRaw({ v: 4, a: 'doc-1', s: 1, q: binding }))
    expectInvalidCursor(encodeRaw({ a: 'doc-1', s: 1, q: binding }))
  })

  it('rejects a missing or malformed binding', () => {
    expectInvalidCursor(encodeRaw({ v: 3, a: 'doc-1', s: 1 }))
    expectInvalidCursor(encodeRaw({ v: 3, a: 'doc-1', s: 1, q: 'AB12CD34' }))
    expectInvalidCursor(encodeRaw({ v: 3, a: 'doc-1', s: 1, q: 'ab12cd3' }))
    expectInvalidCursor(encodeRaw({ v: 3, a: 'doc-1', s: 1, q: 12345678 }))
  })

  it('rejects a missing, empty, or oversized anchor', () => {
    expectInvalidCursor(encodeRaw({ v: 3, s: 1, q: binding }))
    expectInvalidCursor(encodeRaw({ v: 3, a: '', s: 1, q: binding }))
    expectInvalidCursor(encodeRaw({ v: 3, a: 'x'.repeat(513), s: 1, q: binding }))
  })

  it('accepts an anchor of 512 supplementary characters, which exceed 512 UTF-16 units', () => {
    const anchor = String.fromCodePoint(0x1f600).repeat(512)
    const decoded = decodePageCursor(encodeRaw({ v: 3, a: anchor, s: 1, q: binding }))
    expect(decoded.anchor).toBe(anchor)
  })

  it('rejects a non-finite score', () => {
    expectInvalidCursor(encodeRaw({ v: 3, a: 'doc-1', s: 'high', q: binding }))
    expectInvalidCursor(Buffer.from(`{"v":3,"a":"doc-1","s":1e999,"q":"${binding}"}`).toString('base64'))
  })

  it('rejects a cursor carrying both a score and a sort key', () => {
    expectInvalidCursor(encodeRaw({ v: 3, a: 'doc-1', s: 1, k: ['x'], o: '[["f","asc"]]', q: binding }))
  })

  it('rejects a sort key without its sort order, and the reverse', () => {
    expectInvalidCursor(encodeRaw({ v: 3, a: 'doc-1', k: ['x'], q: binding }))
    expectInvalidCursor(encodeRaw({ v: 3, a: 'doc-1', o: '[["f","asc"]]', q: binding }))
  })

  it('rejects a sort key holding more than 8 values or a disallowed value', () => {
    const order = '[["f","asc"]]'
    expectInvalidCursor(encodeRaw({ v: 3, a: 'doc-1', k: Array.from({ length: 9 }, () => 1), o: order, q: binding }))
    expectInvalidCursor(encodeRaw({ v: 3, a: 'doc-1', k: [{ nested: true }], o: order, q: binding }))
    expectInvalidCursor(encodeRaw({ v: 3, a: 'doc-1', k: ['x'.repeat(513)], o: order, q: binding }))
    expectInvalidCursor(
      Buffer.from(`{"v":3,"a":"doc-1","k":[1e999],"o":"[[\\"f\\",\\"asc\\"]]","q":"${binding}"}`).toString('base64'),
    )
  })

  it('rejects a cursor longer than the cap', () => {
    expectInvalidCursor('A'.repeat(MAX_CURSOR_LENGTH + 1))
  })

  it('accepts the largest cursor the payload rules allow', () => {
    const widestValue = '\u0001'.repeat(512)
    const sort: Record<string, 'asc'> = {}
    for (let i = 0; i < 8; i++) sort[`${'f'.repeat(254)}${i}`] = 'asc'
    const signature = sortSignatureOf(sort)
    expect(signature).not.toBeNull()

    const encoded = encodePageCursor({
      anchor: widestValue,
      score: null,
      sortKey: Array.from({ length: 8 }, () => widestValue),
      sortSignature: signature,
      binding,
    })

    expect(encoded.length).toBeLessThanOrEqual(MAX_CURSOR_LENGTH)
    const decoded = decodePageCursor(encoded)
    expect(decoded.anchor).toBe(widestValue)
    expect(decoded.sortKey).toEqual(Array.from({ length: 8 }, () => widestValue))
    expect(decoded.sortSignature).toBe(signature)
    expect(decoded.binding).toBe(binding)
  })

  it('rejects a sort field name longer than 255 characters with SEARCH_INVALID_FIELD', () => {
    try {
      sortSignatureOf({ [`${'f'.repeat(256)}`]: 'asc' })
      expect.unreachable()
    } catch (e) {
      expect((e as NarsilError).code).toBe(ErrorCodes.SEARCH_INVALID_FIELD)
    }
    expect(sortSignatureOf({ [`${'f'.repeat(255)}`]: 'asc' })).toBe(`[["${'f'.repeat(255)}","asc"]]`)
  })

  it('keeps the order of a sort given as a list, including an all-digit field name', () => {
    expect(
      sortSignatureOf([
        { field: 'title', direction: 'asc' },
        { field: '2024', direction: 'desc' },
      ]),
    ).toBe('[["title","asc"],["2024","desc"]]')
    expect(sortSignatureOf({ title: 'asc', 2024: 'desc' })).toBe('[["2024","desc"],["title","asc"]]')
    expect(sortSignatureOf([])).toBeNull()
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
