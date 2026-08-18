import { describe, expect, it } from 'vitest'
import { NarsilError } from '../../errors'
import { hashKey } from '../../react/key'

describe('react hook keys', () => {
  it('reads the same arguments to the same key whatever order the fields came in', () => {
    const first = hashKey(['query', 'movies', { term: 'matrix', limit: 10, fields: ['title'] }])
    const second = hashKey(['query', 'movies', { fields: ['title'], limit: 10, term: 'matrix' }])
    expect(first).toBe(second)
  })

  it('reads a field set to undefined the way an absent field reads', () => {
    expect(hashKey([{ term: 'matrix', cursor: undefined }])).toBe(hashKey([{ term: 'matrix' }]))
  })

  it('separates arguments that differ, down to the type', () => {
    const keys = [
      hashKey(['query', 'movies', { term: 'matrix' }]),
      hashKey(['query', 'movies', { term: 'matrix ' }]),
      hashKey(['query', 'books', { term: 'matrix' }]),
      hashKey(['suggest', 'movies', { term: 'matrix' }]),
      hashKey([{ limit: 10 }]),
      hashKey([{ limit: '10' }]),
      hashKey([{ limit: null }]),
      hashKey([{}]),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('reads a query vector, whether it arrives as an array or as a Float32Array', () => {
    const asArray = hashKey([{ vector: { field: 'embedding', vector: [0.5, 0.25] } }])
    const asTyped = hashKey([{ vector: { field: 'embedding', vector: new Float32Array([0.5, 0.25]) } }])
    expect(asArray).toBe(asTyped)
    expect(asArray).not.toBe(hashKey([{ vector: { field: 'embedding', vector: [0.25, 0.5] } }]))
  })

  it('reads a date the way the client sends it', () => {
    const moment = new Date('2026-08-14T09:00:00.000Z')
    expect(hashKey([{ from: moment }])).toBe(hashKey([{ from: '2026-08-14T09:00:00.000Z' }]))
  })

  it('separates an array from the object holding the same entries', () => {
    expect(hashKey([['a', 'b']])).not.toBe(hashKey([{ 0: 'a', 1: 'b' }]))
  })

  it('refuses an argument no request can depend on', () => {
    expect(() => hashKey([{ onDone: () => undefined }])).toThrow(NarsilError)
    expect(() => hashKey([{ tag: Symbol('tag') }])).toThrow(NarsilError)
  })

  it('refuses an argument that holds a reference back to itself', () => {
    const filters: Record<string, unknown> = { field: 'title' }
    filters.parent = filters
    expect(() => hashKey([filters])).toThrow(NarsilError)
  })

  it('refuses an argument nested deeper than the engine accepts', () => {
    let nested: Record<string, unknown> = {}
    for (let depth = 0; depth < 40; depth++) nested = { nested }
    expect(() => hashKey([nested])).toThrow(NarsilError)
  })
})
