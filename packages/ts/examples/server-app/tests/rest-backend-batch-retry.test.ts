import { describe, expect, it } from 'vitest'
import { uninsertedEntries } from '../src/lib/rest-backend'

const entry = (docId: string | null) => ({ docId, json: `{"id":${JSON.stringify(docId)}}` })

describe('uninsertedEntries', () => {
  it('returns the whole batch when the server accepted nothing', () => {
    const entries = [entry('a'), entry(null), entry('b')]
    expect(uninsertedEntries(entries, [])).toEqual(entries)
  })

  it('returns only the documents the server did not accept', () => {
    const entries = [entry('a'), entry('b'), entry('c')]
    expect(uninsertedEntries(entries, ['a', 'c'])).toEqual([entry('b')])
  })

  it('returns an empty list when the server accepted everything it echoed', () => {
    const entries = [entry('a'), entry('b')]
    expect(uninsertedEntries(entries, ['a', 'b'])).toEqual([])
  })

  it('refuses to pick survivors when a partly accepted batch has documents without string IDs', () => {
    const entries = [entry('a'), entry(null)]
    expect(uninsertedEntries(entries, ['a'])).toBeNull()
  })
})
