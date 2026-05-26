import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { validateSchema } from '../../../schema/validator'

describe('validateSchema', () => {
  it('accepts a valid schema with scalar types', () => {
    expect(() =>
      validateSchema({
        title: 'string',
        price: 'number',
        active: 'boolean',
        category: 'enum',
        location: 'geopoint',
      }),
    ).not.toThrow()
  })

  it('accepts array field types', () => {
    expect(() =>
      validateSchema({
        tags: 'string[]',
        scores: 'number[]',
        flags: 'boolean[]',
        categories: 'enum[]',
      }),
    ).not.toThrow()
  })

  it('accepts vector fields with valid dimensions', () => {
    expect(() => validateSchema({ embedding: 'vector[128]' })).not.toThrow()
    expect(() => validateSchema({ embedding: 'vector[1]' })).not.toThrow()
    expect(() => validateSchema({ embedding: 'vector[1536]' })).not.toThrow()
  })

  it('accepts nested object schemas', () => {
    expect(() =>
      validateSchema({
        title: 'string',
        metadata: {
          author: 'string',
          year: 'number',
        },
      }),
    ).not.toThrow()
  })

  it('accepts nesting up to depth 4', () => {
    expect(() =>
      validateSchema({
        level1: {
          level2: {
            level3: {
              name: 'string',
            },
          },
        },
      }),
    ).not.toThrow()
  })

  it('rejects nesting beyond depth 4', () => {
    expect(() =>
      validateSchema({
        a: {
          b: {
            c: {
              d: {
                name: 'string',
              },
            },
          },
        },
      }),
    ).toThrow(NarsilError)

    try {
      validateSchema({
        a: { b: { c: { d: { tooDeep: 'string' } } } },
      })
    } catch (e) {
      expect(e).toBeInstanceOf(NarsilError)
      expect((e as NarsilError).code).toBe(ErrorCodes.SCHEMA_DEPTH_EXCEEDED)
    }
  })

  it('rejects an empty schema', () => {
    expect(() => validateSchema({})).toThrow(NarsilError)
    try {
      validateSchema({})
    } catch (e) {
      expect((e as NarsilError).code).toBe(ErrorCodes.SCHEMA_INVALID_TYPE)
    }
  })

  it('rejects a non-object schema', () => {
    expect(() => validateSchema('not-an-object' as never)).toThrow(NarsilError)
    expect(() => validateSchema(null as never)).toThrow(NarsilError)
    expect(() => validateSchema([] as never)).toThrow(NarsilError)
  })

  it('rejects unsupported field types', () => {
    expect(() => validateSchema({ field: 'date' as never })).toThrow(NarsilError)

    try {
      validateSchema({ field: 'date' as never })
    } catch (e) {
      expect((e as NarsilError).code).toBe(ErrorCodes.SCHEMA_INVALID_TYPE)
      expect((e as NarsilError).details.field).toBe('field')
    }
  })

  it('rejects vector[0]', () => {
    try {
      validateSchema({ embedding: 'vector[0]' })
    } catch (e) {
      expect(e).toBeInstanceOf(NarsilError)
      expect((e as NarsilError).code).toBe(ErrorCodes.SCHEMA_INVALID_VECTOR_DIMENSION)
      expect((e as NarsilError).details.dimension).toBe(0)
    }
  })

  it('rejects non-numeric type values', () => {
    expect(() => validateSchema({ field: 42 as never })).toThrow(NarsilError)
    expect(() => validateSchema({ field: true as never })).toThrow(NarsilError)
  })

  it('rejects the reserved field name "id" at the root level', () => {
    expect(() => validateSchema({ id: 'string', name: 'string' })).toThrow(NarsilError)

    try {
      validateSchema({ id: 'string', name: 'string' })
    } catch (e) {
      expect((e as NarsilError).code).toBe(ErrorCodes.SCHEMA_INVALID_TYPE)
      expect((e as NarsilError).message).toContain('reserved')
    }
  })

  it('allows "id" as a nested field name', () => {
    expect(() =>
      validateSchema({
        metadata: {
          id: 'string',
        },
      }),
    ).not.toThrow()
  })

  it('validates all fields in the schema before passing', () => {
    expect(() =>
      validateSchema({
        valid: 'string',
        invalid: 'timestamp' as never,
      }),
    ).toThrow(NarsilError)
  })

  it('reports the correct path for nested field errors', () => {
    try {
      validateSchema({
        metadata: {
          nested: {
            bad: 'invalid_type' as never,
          },
        },
      })
    } catch (e) {
      expect((e as NarsilError).details.field).toBe('metadata.nested.bad')
    }
  })
})
