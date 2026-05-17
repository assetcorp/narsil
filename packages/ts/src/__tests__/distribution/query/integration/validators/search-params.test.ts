import { describe, expect, it } from 'vitest'
import { validateSearchPayload } from '../../../../../distribution/query/codec'
import { MAX_CURSOR_LENGTH } from '../../../../../distribution/query/cursor'
import {
  MAX_BOOST_FIELDS,
  MAX_FACETS,
  MAX_FIELDS_LIST,
  MAX_HYBRID_K,
  MAX_LIMIT,
  MAX_OFFSET,
  MAX_PARTITION_COUNT,
  MAX_SORT_FIELDS,
  MAX_TERM_LENGTH,
  MAX_TOLERANCE,
} from '../../../../../distribution/query/validators/common'
import { NarsilError } from '../../../../../errors'
import { makeSearchPayload } from './fixtures'

describe('validateSearchPayload top-level', () => {
  it('throws NarsilError when payload is not an object', () => {
    expect(() => validateSearchPayload('nope')).toThrow(NarsilError)
  })

  it('throws NarsilError when indexName is not a string', () => {
    expect(() => validateSearchPayload(makeSearchPayload({}, { indexName: 42 }))).toThrow(NarsilError)
  })

  it('rejects index names with forbidden characters', () => {
    expect(() => validateSearchPayload(makeSearchPayload({}, { indexName: '../escape' }))).toThrow(NarsilError)
  })

  it('rejects partitionIds with negative values', () => {
    expect(() => validateSearchPayload(makeSearchPayload({}, { partitionIds: [-1] }))).toThrow(/partitionIds/)
  })

  it('rejects partitionIds that exceed MAX_PARTITION_COUNT', () => {
    expect(() => validateSearchPayload(makeSearchPayload({}, { partitionIds: [MAX_PARTITION_COUNT] }))).toThrow(
      /partitionIds/,
    )
  })

  it('rejects fractional partitionIds', () => {
    expect(() => validateSearchPayload(makeSearchPayload({}, { partitionIds: [1.5] }))).toThrow(/partitionIds/)
  })

  it('rejects non-array partitionIds', () => {
    expect(() => validateSearchPayload(makeSearchPayload({}, { partitionIds: 'all' }))).toThrow(/partitionIds/)
  })

  it('accepts partitionId = 0', () => {
    expect(() => validateSearchPayload(makeSearchPayload({}, { partitionIds: [0] }))).not.toThrow()
  })

  it('accepts partitionId at MAX_PARTITION_COUNT - 1', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({}, { partitionIds: [MAX_PARTITION_COUNT - 1] })),
    ).not.toThrow()
  })
})

describe('validateSearchPayload params.term', () => {
  it('accepts null term', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ term: null }))).not.toThrow()
  })

  it('rejects non-string term', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ term: 42 as unknown as string }))).toThrow(/term/)
  })

  it('rejects empty term', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ term: '' }))).toThrow(/term/)
  })

  it('rejects term exceeding MAX_TERM_LENGTH', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ term: 'a'.repeat(MAX_TERM_LENGTH + 1) }))).toThrow(/term/)
  })

  it('accepts term exactly at MAX_TERM_LENGTH', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ term: 'a'.repeat(MAX_TERM_LENGTH) }))).not.toThrow()
  })

  it('rejects term containing a null byte', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ term: `hello${String.fromCharCode(0)}world` }))).toThrow(
      /null bytes/,
    )
  })
})

describe('validateSearchPayload params.limit and params.offset', () => {
  it('rejects limit as a float', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ limit: 10.5 }))).toThrow(/limit/)
  })

  it('rejects negative limit', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ limit: -1 }))).toThrow(/limit/)
  })

  it('rejects limit beyond MAX_LIMIT', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ limit: MAX_LIMIT + 1 }))).toThrow(/limit/)
  })

  it('accepts limit at MAX_LIMIT', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ limit: MAX_LIMIT }))).not.toThrow()
  })

  it('rejects offset as NaN', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ offset: Number.NaN }))).toThrow(/offset/)
  })

  it('rejects offset beyond MAX_OFFSET', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ offset: MAX_OFFSET + 1 }))).toThrow(/offset/)
  })

  it('accepts offset at MAX_OFFSET', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ offset: MAX_OFFSET }))).not.toThrow()
  })
})

describe('validateSearchPayload params.searchAfter', () => {
  it('rejects searchAfter as a number', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ searchAfter: 42 as unknown as string }))).toThrow(
      /searchAfter/,
    )
  })

  it('rejects searchAfter exceeding MAX_CURSOR_LENGTH', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ searchAfter: 'a'.repeat(MAX_CURSOR_LENGTH + 1) }))).toThrow(
      /searchAfter/,
    )
  })

  it('accepts searchAfter exactly at MAX_CURSOR_LENGTH', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ searchAfter: 'a'.repeat(MAX_CURSOR_LENGTH) }))).not.toThrow()
  })
})

describe('validateSearchPayload params.scoring', () => {
  it('rejects unknown scoring mode', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ scoring: 'invalid' as unknown as 'local' | 'dfs' | 'broadcast' })),
    ).toThrow(/scoring/)
  })

  it('accepts each canonical scoring value', () => {
    for (const value of ['local', 'dfs', 'broadcast'] as const) {
      expect(() => validateSearchPayload(makeSearchPayload({ scoring: value }))).not.toThrow()
    }
  })
})

describe('validateSearchPayload params.tolerance', () => {
  it('rejects tolerance as a non-integer', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ tolerance: 1.5 }))).toThrow(/tolerance/)
  })

  it('rejects tolerance below zero', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ tolerance: -1 }))).toThrow(/tolerance/)
  })

  it('rejects tolerance beyond MAX_TOLERANCE', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ tolerance: MAX_TOLERANCE + 1 }))).toThrow(/tolerance/)
  })

  it('accepts tolerance exactly at MAX_TOLERANCE', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ tolerance: MAX_TOLERANCE }))).not.toThrow()
  })
})

describe('validateSearchPayload params.threshold', () => {
  it('rejects threshold as a string', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ threshold: '0.5' as unknown as number }))).toThrow(
      /threshold/,
    )
  })

  it('rejects threshold of Infinity', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ threshold: Number.POSITIVE_INFINITY }))).toThrow(/threshold/)
  })

  it('accepts a finite threshold', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ threshold: 0.5 }))).not.toThrow()
  })
})

describe('validateSearchPayload params.sort', () => {
  it('rejects sort that is not an array', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ sort: { field: 'x' } as unknown as null }))).toThrow(/sort/)
  })

  it('rejects sort exceeding MAX_SORT_FIELDS', () => {
    const oversized = Array.from({ length: MAX_SORT_FIELDS + 1 }, (_, i) => ({
      field: `f${i}`,
      direction: 'asc' as const,
    }))
    expect(() => validateSearchPayload(makeSearchPayload({ sort: oversized }))).toThrow(/sort/)
  })

  it('rejects sort entry with empty field name', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ sort: [{ field: '', direction: 'asc' }] }))).toThrow(/field/)
  })

  it('rejects sort entry with unknown direction', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({ sort: [{ field: 'price', direction: 'sideways' as unknown as 'asc' }] }),
      ),
    ).toThrow(/direction/)
  })

  it('accepts a well-formed sort entry', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ sort: [{ field: 'price', direction: 'desc' }] })),
    ).not.toThrow()
  })
})

describe('validateSearchPayload params.group', () => {
  it('rejects group that is not an object', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ group: 'oops' as unknown as null }))).toThrow(/group/)
  })

  it('rejects group with empty field', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ group: { field: '', maxPerGroup: 3 } }))).toThrow(/field/)
  })

  it('rejects group with negative maxPerGroup', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ group: { field: 'category', maxPerGroup: -1 } }))).toThrow(
      /maxPerGroup/,
    )
  })

  it('accepts a well-formed group', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ group: { field: 'category', maxPerGroup: 5 } })),
    ).not.toThrow()
  })
})

describe('validateSearchPayload params.boost', () => {
  it('rejects boost that is not an object', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ boost: 'oops' as unknown as null }))).toThrow(/boost/)
  })

  it('rejects boost containing non-finite value', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ boost: { title: Number.POSITIVE_INFINITY } }))).toThrow(
      /boost/,
    )
  })

  it('rejects boost containing NaN', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ boost: { title: Number.NaN } }))).toThrow(/boost/)
  })

  it('rejects boost with empty field key', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ boost: { '': 2 } }))).toThrow(/non-empty string/)
  })

  it('rejects boost exceeding MAX_BOOST_FIELDS', () => {
    const oversized: Record<string, number> = {}
    for (let i = 0; i < MAX_BOOST_FIELDS + 1; i++) oversized[`f${i}`] = 1
    expect(() => validateSearchPayload(makeSearchPayload({ boost: oversized }))).toThrow(/boost/)
  })

  it('accepts boost at MAX_BOOST_FIELDS', () => {
    const sized: Record<string, number> = {}
    for (let i = 0; i < MAX_BOOST_FIELDS; i++) sized[`f${i}`] = 1
    expect(() => validateSearchPayload(makeSearchPayload({ boost: sized }))).not.toThrow()
  })

  it('accepts boost containing a finite number', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ boost: { title: 2.5 } }))).not.toThrow()
  })
})

describe('validateSearchPayload params.fields and params.facets', () => {
  it('rejects fields exceeding MAX_FIELDS_LIST', () => {
    const oversized = Array.from({ length: MAX_FIELDS_LIST + 1 }, (_, i) => `f${i}`)
    expect(() => validateSearchPayload(makeSearchPayload({ fields: oversized }))).toThrow(/fields/)
  })

  it('rejects fields containing a non-string entry', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ fields: ['title', 42 as unknown as string] }))).toThrow(
      /fields/,
    )
  })

  it('accepts a well-formed fields array', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ fields: ['title', 'description'] }))).not.toThrow()
  })

  it('rejects facets exceeding MAX_FACETS', () => {
    const oversized = Array.from({ length: MAX_FACETS + 1 }, (_, i) => `f${i}`)
    expect(() => validateSearchPayload(makeSearchPayload({ facets: oversized }))).toThrow(/facets/)
  })

  it('accepts a well-formed facets array', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ facets: ['color', 'size'] }))).not.toThrow()
  })
})

describe('validateSearchPayload params.hybrid', () => {
  it('rejects hybrid that is not an object', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({ hybrid: 'oops' as unknown as { strategy: 'rrf'; k: number; alpha: number } }),
      ),
    ).toThrow(/hybrid/)
  })

  it('rejects unknown strategy', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({ hybrid: { strategy: 'other' as unknown as 'rrf', k: 60, alpha: 0.5 } }),
      ),
    ).toThrow(/strategy/)
  })

  it('rejects non-integer k', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ hybrid: { strategy: 'rrf', k: 1.5, alpha: 0.5 } }))).toThrow(
      /hybrid\.k/,
    )
  })

  it('rejects k beyond MAX_HYBRID_K', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ hybrid: { strategy: 'rrf', k: MAX_HYBRID_K + 1, alpha: 0.5 } })),
    ).toThrow(/hybrid\.k/)
  })

  it('rejects alpha out of [0, 1]', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ hybrid: { strategy: 'rrf', k: 60, alpha: 1.5 } }))).toThrow(
      /alpha/,
    )
  })

  it('rejects alpha that is NaN', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ hybrid: { strategy: 'rrf', k: 60, alpha: Number.NaN } })),
    ).toThrow(/alpha/)
  })

  it('accepts a well-formed hybrid config', () => {
    expect(() =>
      validateSearchPayload(makeSearchPayload({ hybrid: { strategy: 'rrf', k: 60, alpha: 0.5 } })),
    ).not.toThrow()
  })
})

describe('validateSearchPayload globalStats', () => {
  it('accepts null globalStats', () => {
    expect(() => validateSearchPayload(makeSearchPayload({}, { globalStats: null }))).not.toThrow()
  })

  it('rejects globalStats that is not an object', () => {
    expect(() => validateSearchPayload(makeSearchPayload({}, { globalStats: 'oops' }))).toThrow(/globalStats/)
  })

  it('rejects globalStats with non-numeric totalDocuments', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({}, { globalStats: { totalDocuments: 'lots', docFrequencies: {}, totalFieldLengths: {} } }),
      ),
    ).toThrow(/globalStats/)
  })

  it('accepts a well-formed globalStats', () => {
    expect(() =>
      validateSearchPayload(
        makeSearchPayload({}, { globalStats: { totalDocuments: 10, docFrequencies: {}, totalFieldLengths: {} } }),
      ),
    ).not.toThrow()
  })
})
