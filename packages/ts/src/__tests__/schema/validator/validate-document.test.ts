import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { validateDocument } from '../../../schema/validator'

describe('validateDocument', () => {
  const schema = {
    title: 'string' as const,
    price: 'number' as const,
    active: 'boolean' as const,
    category: 'enum' as const,
  }

  it('accepts a valid document', () => {
    expect(() =>
      validateDocument({ title: 'Narsil', price: 29.99, active: true, category: 'weapons' }, schema),
    ).not.toThrow()
  })

  it('allows missing fields (all optional in v1)', () => {
    expect(() => validateDocument({}, schema)).not.toThrow()
    expect(() => validateDocument({ title: 'Narsil' }, schema)).not.toThrow()
  })

  it('allows null fields (treated as absent)', () => {
    expect(() => validateDocument({ title: null }, schema)).not.toThrow()
  })

  it('ignores extra fields not in the schema', () => {
    expect(() => validateDocument({ title: 'Narsil', extraField: 'ignored' }, schema)).not.toThrow()
  })

  it('rejects a non-object document', () => {
    expect(() => validateDocument('string' as never, schema)).toThrow(NarsilError)
    expect(() => validateDocument(null as never, schema)).toThrow(NarsilError)
    expect(() => validateDocument([] as never, schema)).toThrow(NarsilError)

    try {
      validateDocument(42 as never, schema)
    } catch (e) {
      expect((e as NarsilError).code).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
    }
  })

  it('rejects string fields with wrong types', () => {
    try {
      validateDocument({ title: 123 }, schema)
    } catch (e) {
      expect(e).toBeInstanceOf(NarsilError)
      expect((e as NarsilError).code).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
      expect((e as NarsilError).details.field).toBe('title')
      expect((e as NarsilError).details.expected).toBe('string')
    }
  })

  it('rejects number fields with wrong types', () => {
    expect(() => validateDocument({ price: 'cheap' }, schema)).toThrow(NarsilError)
  })

  it('rejects NaN for number fields', () => {
    expect(() => validateDocument({ price: NaN }, schema)).toThrow(NarsilError)

    try {
      validateDocument({ price: NaN }, schema)
    } catch (e) {
      expect((e as NarsilError).details.received).toBe('NaN')
    }
  })

  it('rejects boolean fields with wrong types', () => {
    expect(() => validateDocument({ active: 1 }, schema)).toThrow(NarsilError)
    expect(() => validateDocument({ active: 'true' }, schema)).toThrow(NarsilError)
  })

  it('rejects enum fields with non-string values', () => {
    expect(() => validateDocument({ category: 42 }, schema)).toThrow(NarsilError)
  })

  describe('geopoint validation', () => {
    const geoSchema = { location: 'geopoint' as const }

    it('accepts a valid geopoint', () => {
      expect(() => validateDocument({ location: { lat: 40.7128, lon: -74.006 } }, geoSchema)).not.toThrow()
    })

    it('accepts boundary geopoint values', () => {
      expect(() => validateDocument({ location: { lat: 90, lon: 180 } }, geoSchema)).not.toThrow()
      expect(() => validateDocument({ location: { lat: -90, lon: -180 } }, geoSchema)).not.toThrow()
      expect(() => validateDocument({ location: { lat: 0, lon: 0 } }, geoSchema)).not.toThrow()
    })

    it('rejects non-object geopoints', () => {
      expect(() => validateDocument({ location: 'NYC' }, geoSchema)).toThrow(NarsilError)
      expect(() => validateDocument({ location: [40.7, -74] }, geoSchema)).toThrow(NarsilError)

      try {
        validateDocument({ location: 'NYC' }, geoSchema)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.SCHEMA_INVALID_GEOPOINT)
      }
    })

    it('rejects geopoints with non-numeric lat/lon', () => {
      expect(() => validateDocument({ location: { lat: '40.7', lon: -74 } }, geoSchema)).toThrow(NarsilError)
    })

    it('rejects geopoints with missing lat or lon', () => {
      expect(() => validateDocument({ location: { lat: 40.7 } }, geoSchema)).toThrow(NarsilError)
      expect(() => validateDocument({ location: { lon: -74 } }, geoSchema)).toThrow(NarsilError)
    })

    it('rejects lat outside [-90, 90]', () => {
      expect(() => validateDocument({ location: { lat: 91, lon: 0 } }, geoSchema)).toThrow(NarsilError)
      expect(() => validateDocument({ location: { lat: -91, lon: 0 } }, geoSchema)).toThrow(NarsilError)
    })

    it('rejects lon outside [-180, 180]', () => {
      expect(() => validateDocument({ location: { lat: 0, lon: 181 } }, geoSchema)).toThrow(NarsilError)
      expect(() => validateDocument({ location: { lat: 0, lon: -181 } }, geoSchema)).toThrow(NarsilError)
    })

    it('rejects NaN lat or lon', () => {
      expect(() => validateDocument({ location: { lat: NaN, lon: 0 } }, geoSchema)).toThrow(NarsilError)
      expect(() => validateDocument({ location: { lat: 0, lon: NaN } }, geoSchema)).toThrow(NarsilError)
      expect(() => validateDocument({ location: { lat: NaN, lon: NaN } }, geoSchema)).toThrow(NarsilError)

      try {
        validateDocument({ location: { lat: NaN, lon: 0 } }, geoSchema)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.SCHEMA_INVALID_GEOPOINT)
        expect((e as NarsilError).details.lat).toBe('NaN')
      }
    })
  })

  describe('vector validation', () => {
    const vecSchema = { embedding: 'vector[3]' as const }

    it('accepts a valid array vector', () => {
      expect(() => validateDocument({ embedding: [1.0, 2.0, 3.0] }, vecSchema)).not.toThrow()
    })

    it('accepts a Float32Array vector', () => {
      expect(() => validateDocument({ embedding: new Float32Array([1.0, 2.0, 3.0]) }, vecSchema)).not.toThrow()
    })

    it('rejects vectors with wrong dimensions', () => {
      expect(() => validateDocument({ embedding: [1.0, 2.0] }, vecSchema)).toThrow(NarsilError)
      expect(() => validateDocument({ embedding: [1, 2, 3, 4] }, vecSchema)).toThrow(NarsilError)

      try {
        validateDocument({ embedding: [1.0, 2.0] }, vecSchema)
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
        expect((e as NarsilError).details.expected).toBe(3)
        expect((e as NarsilError).details.received).toBe(2)
      }
    })

    it('rejects non-array/Float32Array vectors', () => {
      expect(() => validateDocument({ embedding: 'not-a-vector' }, vecSchema)).toThrow(NarsilError)
      expect(() => validateDocument({ embedding: { 0: 1, 1: 2, 2: 3 } }, vecSchema)).toThrow(NarsilError)
    })

    it('rejects vectors containing NaN', () => {
      expect(() => validateDocument({ embedding: [1.0, NaN, 3.0] }, vecSchema)).toThrow(NarsilError)
    })

    it('rejects vectors containing non-numeric elements', () => {
      expect(() => validateDocument({ embedding: [1.0, 'two', 3.0] }, vecSchema)).toThrow(NarsilError)
    })
  })

  describe('array field validation', () => {
    it('accepts valid string arrays', () => {
      expect(() => validateDocument({ tags: ['a', 'b', 'c'] }, { tags: 'string[]' })).not.toThrow()
    })

    it('accepts empty arrays', () => {
      expect(() => validateDocument({ tags: [] }, { tags: 'string[]' })).not.toThrow()
    })

    it('accepts valid number arrays', () => {
      expect(() => validateDocument({ scores: [1, 2, 3] }, { scores: 'number[]' })).not.toThrow()
    })

    it('accepts valid boolean arrays', () => {
      expect(() => validateDocument({ flags: [true, false, true] }, { flags: 'boolean[]' })).not.toThrow()
    })

    it('accepts valid enum arrays', () => {
      expect(() => validateDocument({ categories: ['a', 'b'] }, { categories: 'enum[]' })).not.toThrow()
    })

    it('rejects non-array values for array fields', () => {
      expect(() => validateDocument({ tags: 'not-array' }, { tags: 'string[]' })).toThrow(NarsilError)
    })

    it('rejects array elements with wrong types', () => {
      expect(() => validateDocument({ tags: ['valid', 42] }, { tags: 'string[]' })).toThrow(NarsilError)

      try {
        validateDocument({ tags: ['valid', 42] }, { tags: 'string[]' })
      } catch (e) {
        expect((e as NarsilError).code).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
        expect((e as NarsilError).details.index).toBe(1)
      }
    })

    it('rejects NaN in number arrays', () => {
      expect(() => validateDocument({ scores: [1, NaN, 3] }, { scores: 'number[]' })).toThrow(NarsilError)
    })
  })

  describe('nested object validation', () => {
    const nestedSchema = {
      metadata: {
        author: 'string' as const,
        stats: {
          views: 'number' as const,
        },
      },
    }

    it('accepts valid nested documents', () => {
      expect(() =>
        validateDocument({ metadata: { author: 'Tolkien', stats: { views: 1000 } } }, nestedSchema),
      ).not.toThrow()
    })

    it('allows missing nested objects', () => {
      expect(() => validateDocument({}, nestedSchema)).not.toThrow()
    })

    it('allows partial nested objects', () => {
      expect(() => validateDocument({ metadata: { author: 'Tolkien' } }, nestedSchema)).not.toThrow()
    })

    it('rejects non-object values for nested schema fields', () => {
      expect(() => validateDocument({ metadata: 'not-an-object' }, nestedSchema)).toThrow(NarsilError)
      expect(() => validateDocument({ metadata: [1, 2, 3] }, nestedSchema)).toThrow(NarsilError)
    })

    it('validates deeply nested field types', () => {
      expect(() => validateDocument({ metadata: { stats: { views: 'not-a-number' } } }, nestedSchema)).toThrow(
        NarsilError,
      )
    })

    it('reports the full dotted path on nested errors', () => {
      try {
        validateDocument({ metadata: { stats: { views: 'bad' } } }, nestedSchema)
      } catch (e) {
        expect((e as NarsilError).details.field).toBe('metadata.stats.views')
      }
    })
  })
})
