import { describe, expect, it } from 'vitest'
import { validateSearchPayload } from '../../../../../distribution/query/codec'
import {
  MAX_EF_SEARCH,
  MAX_GROUP_FIELDS,
  MAX_PINNED_ENTRIES,
  MAX_PINNED_POSITION,
  MAX_TERMS_COUNT,
} from '../../../../../distribution/query/validators/common'
import { makeSearchPayload } from './fixtures'

describe('validateSearchPayload params.termMatch', () => {
  it('accepts all, any, and a count', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ termMatch: 'all' }))).not.toThrow()
    expect(() => validateSearchPayload(makeSearchPayload({ termMatch: 'any' }))).not.toThrow()
    expect(() => validateSearchPayload(makeSearchPayload({ termMatch: 2 }))).not.toThrow()
  })

  it('rejects an unknown policy string', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ termMatch: 'most' as unknown as 'all' }))).toThrow(
      /termMatch/,
    )
  })

  it('rejects a fractional or oversized count', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ termMatch: 1.5 }))).toThrow(/termMatch/)
    expect(() => validateSearchPayload(makeSearchPayload({ termMatch: MAX_TERMS_COUNT + 1 }))).toThrow(/termMatch/)
  })

  it('rejects a zero or negative count', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ termMatch: 0 }))).toThrow(/termMatch/)
    expect(() => validateSearchPayload(makeSearchPayload({ termMatch: -1 }))).toThrow(/termMatch/)
  })
})

describe('validateSearchPayload params.prefixLength', () => {
  it('accepts zero and a small length', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ prefixLength: 0 }))).not.toThrow()
    expect(() => validateSearchPayload(makeSearchPayload({ prefixLength: 4 }))).not.toThrow()
  })

  it('rejects a negative, fractional, or oversized length', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ prefixLength: -1 }))).toThrow(/prefixLength/)
    expect(() => validateSearchPayload(makeSearchPayload({ prefixLength: 1.5 }))).toThrow(/prefixLength/)
    expect(() => validateSearchPayload(makeSearchPayload({ prefixLength: 1025 }))).toThrow(/prefixLength/)
  })
})

describe('validateSearchPayload params.prefix and params.exact', () => {
  it('accepts booleans and null', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ prefix: true, exact: false }))).not.toThrow()
    expect(() => validateSearchPayload(makeSearchPayload({ prefix: null, exact: null }))).not.toThrow()
  })

  it('rejects a non-boolean', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ prefix: 'yes' as unknown as boolean }))).toThrow(/prefix/)
    expect(() => validateSearchPayload(makeSearchPayload({ exact: 1 as unknown as boolean }))).toThrow(/exact/)
  })
})

describe('validateSearchPayload params.pinned', () => {
  it('accepts a well-formed list', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ pinned: [{ docId: 'kb-1', position: 0 }] }))).not.toThrow()
  })

  it('rejects an entry missing its docId or position', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({ pinned: [{ position: 0 } as unknown as { docId: string; position: number }] }),
      ),
    ).toThrow(/pinned/)
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({ pinned: [{ docId: 'kb-1' } as unknown as { docId: string; position: number }] }),
      ),
    ).toThrow(/pinned/)
  })

  it('rejects a negative or oversized position', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ pinned: [{ docId: 'kb-1', position: -1 }] }))).toThrow(
      /pinned/,
    )
    expect(() =>
      validateSearchPayload(makeSearchPayload({ pinned: [{ docId: 'kb-1', position: MAX_PINNED_POSITION + 1 }] })),
    ).toThrow(/pinned/)
  })

  it('rejects a list beyond the entry cap', () => {
    const pinned = Array.from({ length: MAX_PINNED_ENTRIES + 1 }, (_, i) => ({ docId: `d-${i}`, position: i }))
    expect(() => validateSearchPayload(makeSearchPayload({ pinned }))).toThrow(/pinned/)
  })

  it('rejects an oversized docId', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ pinned: [{ docId: 'x'.repeat(513), position: 0 }] })),
    ).toThrow(/pinned/)
  })
})

describe('validateSearchPayload params.mode', () => {
  it('accepts the three modes and null', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ mode: 'fulltext' }))).not.toThrow()
    expect(() => validateSearchPayload(makeSearchPayload({ mode: null }))).not.toThrow()
  })

  it('rejects an unknown mode', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ mode: 'psychic' as unknown as 'fulltext' }))).toThrow(/mode/)
  })
})

describe('validateSearchPayload params.vector metric and efSearch', () => {
  const vector = { field: 'embedding', value: [0.1], text: null, similarity: null }

  it('accepts a known metric and a sane efSearch', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ vector: { ...vector, metric: 'euclidean', efSearch: 128 } })),
    ).not.toThrow()
  })

  it('rejects an unknown metric', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({ vector: { ...vector, metric: 'manhattan' as unknown as 'cosine', efSearch: null } }),
      ),
    ).toThrow(/metric/)
  })

  it('rejects a non-positive or oversized efSearch', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ vector: { ...vector, metric: null, efSearch: 0 } })),
    ).toThrow(/efSearch/)
    expect(() =>
      validateSearchPayload(makeSearchPayload({ vector: { ...vector, metric: null, efSearch: MAX_EF_SEARCH + 1 } })),
    ).toThrow(/efSearch/)
  })
})

describe('validateSearchPayload params.hybrid with absent members', () => {
  it('accepts null members', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ hybrid: { strategy: null, k: null, alpha: null } })),
    ).not.toThrow()
  })

  it('still rejects an out-of-range present member', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ hybrid: { strategy: null, k: 0, alpha: null } }))).toThrow(
      /hybrid.k/,
    )
    expect(() => validateSearchPayload(makeSearchPayload({ hybrid: { strategy: null, k: null, alpha: 2 } }))).toThrow(
      /hybrid.alpha/,
    )
  })
})

describe('validateSearchPayload params.group fields list', () => {
  it('accepts several fields', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ group: { fields: ['category', 'brand'], maxPerGroup: 2 } })),
    ).not.toThrow()
  })

  it('rejects an empty list and a list beyond the cap', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ group: { fields: [], maxPerGroup: 1 } }))).toThrow(/group/)
    const fields = Array.from({ length: MAX_GROUP_FIELDS + 1 }, (_, i) => `f${i}`)
    expect(() => validateSearchPayload(makeSearchPayload({ group: { fields, maxPerGroup: 1 } }))).toThrow(/group/)
  })
})
