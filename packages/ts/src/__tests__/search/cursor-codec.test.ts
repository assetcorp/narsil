import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeCursorText, encodeCursorText } from '../../search/cursor-codec'
import { decodeCursor, encodeCursor, type SearchCursor } from '../../search/pagination'

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

  it('round-trips a search cursor holding such a document id with no Buffer', () => {
    vi.stubGlobal('Buffer', undefined)
    const state: SearchCursor[] = [{ s: 1.5, d: OUTSIDE_LATIN1, p: 0 }]
    expect(decodeCursor(encodeCursor(state))).toEqual(state)
  })
})
