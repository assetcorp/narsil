import { describe, expect, it } from 'vitest'
import { MAX_FILTER_ARRAY_SIZE, MAX_FILTER_DEPTH, MAX_FILTER_TESTS } from '../../filters/constants'
import { filterTestCount, validatedFilterOf } from '../../filters/operands'
import type { FilterExpression } from '../../types/filters'
import type { FieldType } from '../../types/schema'

const FIELD_TYPES: Record<string, FieldType> = {
  price: 'number',
  title: 'string',
  code: 'string:pattern',
  tags: 'string[]',
  labels: 'string[]:pattern',
  sizes: 'number[]',
  colours: 'enum[]',
  flags: 'boolean[]',
  depot: 'geopoint',
}

function malformed(expression: unknown): () => void {
  return () => validatedFilterOf(expression as FilterExpression, FIELD_TYPES)
}

function nestedNot(depth: number): FilterExpression {
  let expression: FilterExpression = { fields: { price: { gt: 1 } } }
  for (let level = 0; level < depth; level++) expression = { not: expression }
  return expression
}

function ring(points: number): Array<{ lat: number; lon: number }> {
  return Array.from({ length: points }, (_, at) => ({
    lat: 10 * Math.sin((2 * Math.PI * at) / points),
    lon: 10 * Math.cos((2 * Math.PI * at) / points),
  }))
}

const invalidFilter = expect.objectContaining({ code: 'SEARCH_INVALID_FILTER' })

describe('the shape of a filter expression', () => {
  it('refuses "and" and "or" clauses that are not lists', () => {
    expect(malformed({ and: { fields: { price: { gt: 1 } } } })).toThrow(invalidFilter)
    expect(malformed({ or: 'price' })).toThrow(invalidFilter)
  })

  it('refuses a "not" clause, a nested clause, a "fields" clause, or a field filter that is not an object', () => {
    expect(malformed({ not: 5 })).toThrow(invalidFilter)
    expect(malformed({ and: [null] })).toThrow(invalidFilter)
    expect(malformed({ fields: ['price'] })).toThrow(invalidFilter)
    expect(malformed({ fields: { price: 5 } })).toThrow(invalidFilter)
    expect(malformed({ fields: { price: null } })).toThrow(invalidFilter)
  })

  it('refuses a polygon whose points carry no finite latitude and longitude', () => {
    expect(malformed({ fields: { depot: { polygon: { points: [null, null, null] } } } })).toThrow(invalidFilter)
    expect(
      malformed({
        fields: {
          depot: {
            polygon: {
              points: [
                { lat: 1, lon: 1 },
                { lat: 2, lon: Number.NaN },
                { lat: 3, lon: 1 },
              ],
            },
          },
        },
      }),
    ).toThrow(invalidFilter)
  })

  it('refuses an expression nested deeper than the limit and accepts one at the limit', () => {
    expect(malformed(nestedNot(MAX_FILTER_DEPTH + 1))).toThrow(invalidFilter)
    expect(malformed(nestedNot(MAX_FILTER_DEPTH))).not.toThrow()
  })

  it('accepts a well-formed expression', () => {
    expect(
      malformed({
        and: [{ fields: { price: { between: [1, 9] } } }, { or: [{ fields: { code: { startsWith: 'Urban' } } }] }],
      }),
    ).not.toThrow()
  })
})

describe('the fields that a filter can test', () => {
  it('refuses a field that the schema leaves out, with SEARCH_INVALID_FIELD', () => {
    for (const field of ['weight', 'constructor', '__proto__', 'dims.width']) {
      expect(malformed({ fields: { [field]: { exists: true } } })).toThrow(
        expect.objectContaining({ code: 'SEARCH_INVALID_FIELD', details: { field, option: 'filter' } }),
      )
    }
  })

  it('refuses every whole-value test on a text field without a pattern index, and names the option to add', () => {
    const wholeValueTests: Array<[string, unknown]> = [
      ['eq', 'x'],
      ['ne', 'x'],
      ['in', ['x']],
      ['nin', ['x']],
      ['startsWith', 'x'],
      ['endsWith', 'x'],
    ]
    for (const [operator, operand] of wholeValueTests) {
      expect(malformed({ fields: { title: { [operator]: operand } } })).toThrow(/"string:pattern"/)
      expect(malformed({ fields: { tags: { [operator]: operand } } })).toThrow(/"string\[\]:pattern"/)
      expect(malformed({ fields: { code: { [operator]: operand } } })).not.toThrow()
      expect(malformed({ fields: { labels: { [operator]: operand } } })).not.toThrow()
    }
    for (const operator of ['matchesAny', 'containsAll']) {
      expect(malformed({ fields: { tags: { [operator]: ['x'] } } })).toThrow(/"string\[\]:pattern"/)
      expect(malformed({ fields: { labels: { [operator]: ['x'] } } })).not.toThrow()
    }
  })

  it('keeps presence tests on every declared field, and refuses a presence test that is not true or false', () => {
    for (const field of Object.keys(FIELD_TYPES)) {
      for (const operator of ['exists', 'notExists', 'isEmpty', 'isNotEmpty']) {
        expect(malformed({ fields: { [field]: { [operator]: false } } })).not.toThrow()
        expect(malformed({ fields: { [field]: { [operator]: 'yes' } } })).toThrow(invalidFilter)
      }
    }
  })

  it('applies element and size tests to list fields alone, with values of the element type', () => {
    expect(malformed({ fields: { sizes: { matchesAny: [1, 2], containsAll: [3], size: { gte: 1 } } } })).not.toThrow()
    expect(malformed({ fields: { colours: { matchesAny: ['red'] } } })).not.toThrow()
    expect(malformed({ fields: { flags: { containsAll: [true] } } })).not.toThrow()
    expect(malformed({ fields: { price: { matchesAny: [1] } } })).toThrow(invalidFilter)
    expect(malformed({ fields: { price: { size: { eq: 1 } } } })).toThrow(invalidFilter)
    expect(malformed({ fields: { sizes: { matchesAny: ['1'] } } })).toThrow(invalidFilter)
    expect(malformed({ fields: { colours: { containsAll: [1] } } })).toThrow(invalidFilter)
    expect(malformed({ fields: { flags: { matchesAny: 'true' } } })).toThrow(invalidFilter)
    expect(malformed({ fields: { sizes: { size: { exists: true } } } })).toThrow(invalidFilter)
    expect(malformed({ fields: { sizes: { size: { between: [1] } } } })).toThrow(invalidFilter)
    expect(malformed({ fields: { sizes: { size: { gt: '1' } } } })).toThrow(invalidFilter)
  })
})

describe('the limits on one filter', () => {
  it(`accepts ${MAX_FILTER_TESTS} tests and refuses one more, wherever the tests are`, () => {
    const tests = (count: number) => Array.from({ length: count }, (_, at) => ({ fields: { price: { eq: at } } }))
    expect(malformed({ or: tests(MAX_FILTER_TESTS) })).not.toThrow()
    expect(malformed({ or: tests(MAX_FILTER_TESTS + 1) })).toThrow(invalidFilter)
    expect(
      malformed({ and: [{ or: tests(MAX_FILTER_TESTS / 2) }, { not: { or: tests(MAX_FILTER_TESTS / 2 + 1) } }] }),
    ).toThrow(invalidFilter)
  })

  it('counts an empty expression and an empty field filter as one test each, each size bound as one, and caseFold as none', () => {
    expect(filterTestCount({})).toBe(1)
    expect(filterTestCount({ or: [{}, {}, { not: {} }] })).toBe(3)
    expect(filterTestCount({ fields: { price: {} } })).toBe(1)
    expect(filterTestCount({ fields: { sizes: { size: { gte: 1, lte: 3 } } } })).toBe(2)
    expect(filterTestCount({ fields: { code: { eq: 'a', caseFold: true } } })).toBe(1)
    expect(malformed({ or: Array.from({ length: MAX_FILTER_TESTS + 1 }, () => ({})) })).toThrow(invalidFilter)
  })

  it(`accepts lists of ${MAX_FILTER_ARRAY_SIZE} values and polygons of as many points, and refuses one more`, () => {
    const values = (count: number) => Array.from({ length: count }, (_, at) => `v${at}`)
    expect(malformed({ fields: { code: { in: values(MAX_FILTER_ARRAY_SIZE) } } })).not.toThrow()
    expect(malformed({ fields: { code: { nin: values(MAX_FILTER_ARRAY_SIZE + 1) } } })).toThrow(invalidFilter)
    expect(malformed({ fields: { labels: { matchesAny: values(MAX_FILTER_ARRAY_SIZE + 1) } } })).toThrow(invalidFilter)
    expect(malformed({ fields: { depot: { polygon: { points: ring(MAX_FILTER_ARRAY_SIZE) } } } })).not.toThrow()
    expect(malformed({ fields: { depot: { polygon: { points: ring(MAX_FILTER_ARRAY_SIZE + 1) } } } })).toThrow(
      invalidFilter,
    )
  })
})
