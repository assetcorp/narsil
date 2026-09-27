import { describe, expect, it } from 'vitest'
import { MAX_FILTER_DEPTH } from '../../filters/constants'
import { requireValidFilter } from '../../filters/operands'
import type { FilterExpression } from '../../types/filters'
import type { FieldType } from '../../types/schema'

const FIELD_TYPES: Record<string, FieldType> = { price: 'number', title: 'string', depot: 'geopoint' }

function malformed(expression: unknown): () => void {
  return () => requireValidFilter(expression as FilterExpression, FIELD_TYPES)
}

function nestedNot(depth: number): FilterExpression {
  let expression: FilterExpression = { fields: { price: { gt: 1 } } }
  for (let level = 0; level < depth; level++) expression = { not: expression }
  return expression
}

describe('the shape of a filter expression', () => {
  const invalidFilter = expect.objectContaining({ code: 'SEARCH_INVALID_FILTER' })

  it('refuses "and" and "or" clauses that are not lists', () => {
    expect(malformed({ and: { fields: { price: { gt: 1 } } } })).toThrow(invalidFilter)
    expect(malformed({ or: 'price' })).toThrow(invalidFilter)
  })

  it('refuses a "not" clause, a nested clause, or a "fields" clause that is not an object', () => {
    expect(malformed({ not: 5 })).toThrow(invalidFilter)
    expect(malformed({ and: [null] })).toThrow(invalidFilter)
    expect(malformed({ fields: ['price'] })).toThrow(invalidFilter)
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
        and: [{ fields: { price: { between: [1, 9] } } }, { or: [{ fields: { title: { startsWith: 'Urban' } } }] }],
      }),
    ).not.toThrow()
  })
})
