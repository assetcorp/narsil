import { describe, expect, it } from 'vitest'
import { validateSearchPayload } from '../../../../../distribution/query/codec'
import { makeSearchPayload } from './fixtures'

describe('validateSearchPayload params.sort mode', () => {
  it('accepts each of the four list modes and rejects any other', () => {
    for (const mode of ['min', 'max', 'avg', 'median'] as const) {
      expect(() =>
        validateSearchPayload(makeSearchPayload({ sort: [{ field: 'prices', direction: 'asc', mode }] })),
      ).not.toThrow()
    }
    const sum = { field: 'prices', direction: 'asc', mode: 'sum' } as unknown as { field: string; direction: 'asc' }
    expect(() => validateSearchPayload(makeSearchPayload({ sort: [sum] }))).toThrow(/mode/)
  })
})
