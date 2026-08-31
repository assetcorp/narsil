import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodePageCursor, encodePageCursor, type PageCursor } from '../../search/cursor'
import { decodeCursorText, encodeCursorText } from '../../search/cursor-codec'

const OUTSIDE_LATIN1 = '文件-🔍-é'

describe('cursor codec', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('round-trips text outside Latin-1 on the Node path', () => {
    expect(decodeCursorText(encodeCursorText(OUTSIDE_LATIN1))).toBe(OUTSIDE_LATIN1)
  })

  it('round-trips text outside Latin-1 with no Buffer, as a browser has', () => {
    vi.stubGlobal('Buffer', undefined)
    expect(decodeCursorText(encodeCursorText(OUTSIDE_LATIN1))).toBe(OUTSIDE_LATIN1)
  })

  it('round-trips a page cursor holding such a document id with no Buffer', () => {
    vi.stubGlobal('Buffer', undefined)
    const cursor: PageCursor = {
      anchor: OUTSIDE_LATIN1,
      score: 1.5,
      sortKey: null,
      sortSignature: null,
      binding: 'ab12cd34',
    }
    expect(decodePageCursor(encodePageCursor(cursor))).toEqual(cursor)
  })
})
