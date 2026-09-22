import { describe, expect, it } from 'vitest'
import { ErrorCodes, isNarsilError, NarsilError } from '../../errors'

const MARKER = Symbol.for('@delali/narsil.NarsilError')

describe('recognising a NarsilError from another bundle', () => {
  it('answers true for an error a second copy of the class built', () => {
    class NarsilErrorFromAnotherBundle extends Error {
      readonly code = ErrorCodes.INDEX_NOT_FOUND
      readonly details = { indexName: 'docs' }

      constructor(message: string) {
        super(message)
        this.name = 'NarsilError'
        Object.defineProperty(this, MARKER, { value: true })
      }
    }

    const fromAnotherBundle = new NarsilErrorFromAnotherBundle('gone')

    expect(fromAnotherBundle instanceof NarsilError).toBe(false)
    expect(isNarsilError(fromAnotherBundle)).toBe(true)
    expect(isNarsilError(new NarsilError(ErrorCodes.INDEX_NOT_FOUND, 'gone'))).toBe(true)
    expect(isNarsilError(new Error('plain'))).toBe(false)
    expect(isNarsilError(null)).toBe(false)
    expect(isNarsilError({ code: 'INDEX_NOT_FOUND' })).toBe(false)
  })

  it('keeps the marker out of a copy made from the enumerable fields', () => {
    const original = new NarsilError(ErrorCodes.INDEX_NOT_FOUND, 'gone', { indexName: 'docs' })

    expect(Object.keys(original)).not.toContain(MARKER)
    expect(JSON.parse(JSON.stringify({ ...original }))).toEqual({
      name: 'NarsilError',
      code: ErrorCodes.INDEX_NOT_FOUND,
      details: { indexName: 'docs' },
    })
  })
})
