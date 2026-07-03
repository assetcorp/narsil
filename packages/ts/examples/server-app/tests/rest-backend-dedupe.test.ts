import { describe, expect, it } from 'vitest'
import { dedupeDocumentsById } from '../src/lib/rest-backend'

describe('dedupeDocumentsById', () => {
  it('keeps the first occurrence of a repeated ID', () => {
    const docs = [
      { id: 'a', title: 'first' },
      { id: 'b', title: 'other' },
      { id: 'a', title: 'repeat' },
    ]
    expect(dedupeDocumentsById(docs)).toEqual([
      { id: 'a', title: 'first' },
      { id: 'b', title: 'other' },
    ])
  })

  it('treats numeric and string IDs as distinct keys', () => {
    const docs = [{ id: 1 }, { id: '1' }, { id: 1 }]
    expect(dedupeDocumentsById(docs)).toEqual([{ id: 1 }, { id: '1' }])
  })

  it('keeps every document without a usable ID', () => {
    const docs = [{ title: 'x' }, { title: 'y' }, { id: undefined, title: 'z' }]
    expect(dedupeDocumentsById(docs)).toEqual(docs)
  })

  it('returns an equal list when IDs are already unique', () => {
    const docs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(dedupeDocumentsById(docs)).toEqual(docs)
  })
})
