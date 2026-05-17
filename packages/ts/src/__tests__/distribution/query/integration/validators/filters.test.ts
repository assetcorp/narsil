import { describe, expect, it } from 'vitest'
import { validateSearchPayload } from '../../../../../distribution/query/codec'
import {
  MAX_FILTER_ARRAY_SIZE,
  MAX_FILTER_DEPTH,
  MAX_FILTER_FIELDS,
  MAX_FILTER_STRING_LENGTH,
} from '../../../../../distribution/query/validators/common'
import { validateFilterExpression } from '../../../../../distribution/query/validators/filters'
import { NarsilError } from '../../../../../errors'
import { makeSearchPayload } from './fixtures'

describe('validateFilterExpression top-level', () => {
  it('rejects non-object expression', () => {
    expect(() => validateFilterExpression('oops', 'filters')).toThrow(NarsilError)
  })

  it('rejects empty filter object', () => {
    expect(() => validateFilterExpression({}, 'filters')).toThrow(/at least one clause/)
  })

  it('rejects unknown clause key', () => {
    expect(() => validateFilterExpression({ unknown: {} }, 'filters')).toThrow(/unsupported clause/)
  })

  it('rejects nesting beyond MAX_FILTER_DEPTH', () => {
    let nested: Record<string, unknown> = { fields: { price: { gt: 1 } } }
    for (let i = 0; i < MAX_FILTER_DEPTH + 5; i++) {
      nested = { not: nested }
    }
    expect(() => validateFilterExpression(nested, 'filters')).toThrow(/depth/)
  })

  it('accepts deeply nested but bounded expression', () => {
    let nested: Record<string, unknown> = { fields: { price: { gt: 1 } } }
    for (let i = 0; i < 5; i++) {
      nested = { not: nested }
    }
    expect(() => validateFilterExpression(nested, 'filters')).not.toThrow()
  })
})

describe('validateFilterExpression fields record', () => {
  it('rejects fields that is not an object', () => {
    expect(() => validateFilterExpression({ fields: [] as unknown as Record<string, unknown> }, 'filters')).toThrow(
      /fields/,
    )
  })

  it('rejects empty fields object', () => {
    expect(() => validateFilterExpression({ fields: {} }, 'filters')).toThrow(/at least one field/)
  })

  it('rejects fields entry that is not an object', () => {
    expect(() => validateFilterExpression({ fields: { price: 'not-an-op' } }, 'filters')).toThrow(/price/)
  })

  it('rejects unsupported operator', () => {
    expect(() =>
      validateFilterExpression({ fields: { price: { evilOp: 1 } as unknown as Record<string, unknown> } }, 'filters'),
    ).toThrow(/unsupported operator/)
  })

  it('rejects fields exceeding MAX_FILTER_FIELDS', () => {
    const oversized: Record<string, unknown> = {}
    for (let i = 0; i < MAX_FILTER_FIELDS + 1; i++) oversized[`f${i}`] = { gt: 0 }
    expect(() => validateFilterExpression({ fields: oversized }, 'filters')).toThrow(/field count/)
  })

  it('accepts fields exactly at MAX_FILTER_FIELDS', () => {
    const sized: Record<string, unknown> = {}
    for (let i = 0; i < MAX_FILTER_FIELDS; i++) sized[`f${i}`] = { gt: 0 }
    expect(() => validateFilterExpression({ fields: sized }, 'filters')).not.toThrow()
  })
})

describe('validateFilterExpression operands', () => {
  it('rejects NaN as gt operand', () => {
    expect(() => validateFilterExpression({ fields: { price: { gt: Number.NaN } } }, 'filters')).toThrow(/gt/)
  })

  it('rejects Infinity as lt operand', () => {
    expect(() => validateFilterExpression({ fields: { price: { lt: Number.POSITIVE_INFINITY } } }, 'filters')).toThrow(
      /lt/,
    )
  })

  it('rejects object as eq operand', () => {
    expect(() => validateFilterExpression({ fields: { color: { eq: { malicious: true } } } }, 'filters')).toThrow(/eq/)
  })

  it('rejects between with the wrong array length', () => {
    expect(() => validateFilterExpression({ fields: { price: { between: [1, 2, 3] } } }, 'filters')).toThrow(/between/)
  })

  it('rejects in with a non-array', () => {
    expect(() => validateFilterExpression({ fields: { color: { in: 'red' } } }, 'filters')).toThrow(/in/)
  })

  it('rejects in array exceeding MAX_FILTER_ARRAY_SIZE', () => {
    const oversized = Array.from({ length: MAX_FILTER_ARRAY_SIZE + 1 }, (_, i) => `v${i}`)
    expect(() => validateFilterExpression({ fields: { color: { in: oversized } } }, 'filters')).toThrow(/in/)
  })

  it('rejects in entry that is not a string', () => {
    expect(() =>
      validateFilterExpression({ fields: { color: { in: ['red', 42 as unknown as string] } } }, 'filters'),
    ).toThrow(/in/)
  })

  it('rejects startsWith with overlong string', () => {
    expect(() =>
      validateFilterExpression(
        { fields: { name: { startsWith: 'a'.repeat(MAX_FILTER_STRING_LENGTH + 1) } } },
        'filters',
      ),
    ).toThrow(/startsWith/)
  })

  it('rejects exists with a non-boolean', () => {
    expect(() =>
      validateFilterExpression({ fields: { name: { exists: 'yes' as unknown as boolean } } }, 'filters'),
    ).toThrow(/exists/)
  })

  it('rejects size that is not an object', () => {
    expect(() =>
      validateFilterExpression({ fields: { tags: { size: 3 as unknown as Record<string, unknown> } } }, 'filters'),
    ).toThrow(/size/)
  })

  it('accepts a size comparison', () => {
    expect(() => validateFilterExpression({ fields: { tags: { size: { gte: 1 } } } }, 'filters')).not.toThrow()
  })
})

describe('validateFilterExpression and/or arrays', () => {
  it('rejects empty and array', () => {
    expect(() => validateFilterExpression({ and: [] }, 'filters')).toThrow(/and/)
  })

  it('rejects empty or array', () => {
    expect(() => validateFilterExpression({ or: [] }, 'filters')).toThrow(/or/)
  })

  it('rejects and exceeding MAX_FILTER_FIELDS expressions', () => {
    const oversized = Array.from({ length: MAX_FILTER_FIELDS + 1 }, () => ({ fields: { price: { gt: 0 } } }))
    expect(() => validateFilterExpression({ and: oversized }, 'filters')).toThrow(/and/)
  })

  it('accepts well-formed and/or', () => {
    expect(() =>
      validateFilterExpression(
        {
          and: [{ fields: { price: { gt: 0 } } }, { or: [{ fields: { color: { eq: 'red' } } }] }],
        },
        'filters',
      ),
    ).not.toThrow()
  })
})

describe('validateFilterExpression geo operators', () => {
  it('rejects radius with non-numeric lat', () => {
    expect(() =>
      validateFilterExpression(
        {
          fields: {
            location: {
              radius: { lat: 'oops', lon: 0, distance: 10, unit: 'km' } as unknown as Record<string, unknown>,
            },
          },
        },
        'filters',
      ),
    ).toThrow(/lat/)
  })

  it('rejects radius with unknown unit', () => {
    expect(() =>
      validateFilterExpression(
        {
          fields: {
            location: {
              radius: { lat: 0, lon: 0, distance: 10, unit: 'parsec' as unknown as 'km' },
            },
          },
        },
        'filters',
      ),
    ).toThrow(/unit/)
  })

  it('rejects radius with negative distance', () => {
    expect(() =>
      validateFilterExpression(
        { fields: { location: { radius: { lat: 0, lon: 0, distance: -1, unit: 'km' } } } },
        'filters',
      ),
    ).toThrow(/distance/)
  })

  it('rejects polygon points entry without lat/lon', () => {
    expect(() =>
      validateFilterExpression(
        {
          fields: {
            location: {
              polygon: {
                points: [
                  { lat: 0, lon: 0 },
                  { lat: 'oops' as unknown as number, lon: 0 },
                ],
              },
            },
          },
        },
        'filters',
      ),
    ).toThrow(/lat/)
  })

  it('accepts a well-formed polygon', () => {
    expect(() =>
      validateFilterExpression(
        {
          fields: {
            location: {
              polygon: {
                points: [
                  { lat: 0, lon: 0 },
                  { lat: 1, lon: 0 },
                  { lat: 0, lon: 1 },
                ],
              },
            },
          },
        },
        'filters',
      ),
    ).not.toThrow()
  })
})

describe('validateSearchPayload params.filters integration', () => {
  it('rejects malformed filters via the top-level validator', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ filters: { fields: { price: { gt: 'oops' } } } }))).toThrow(
      /gt/,
    )
  })

  it('accepts well-formed filters via the top-level validator', () => {
    expect(() => validateSearchPayload(makeSearchPayload({ filters: { fields: { price: { gt: 10 } } } }))).not.toThrow()
  })
})
