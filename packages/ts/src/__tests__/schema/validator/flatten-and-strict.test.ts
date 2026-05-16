import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { flattenSchema, validateDocumentStrict } from '../../../schema/validator'

describe('flattenSchema', () => {
  it('returns flat fields unchanged', () => {
    const result = flattenSchema({
      title: 'string',
      price: 'number',
    })
    expect(result).toEqual({ title: 'string', price: 'number' })
  })

  it('flattens nested objects with dot notation', () => {
    const result = flattenSchema({
      metadata: {
        author: 'string',
        year: 'number',
      },
    })
    expect(result).toEqual({
      'metadata.author': 'string',
      'metadata.year': 'number',
    })
  })

  it('flattens deeply nested schemas', () => {
    const result = flattenSchema({
      a: {
        b: {
          c: {
            d: 'string',
          },
        },
      },
    })
    expect(result).toEqual({ 'a.b.c.d': 'string' })
  })

  it('handles mixed flat and nested fields', () => {
    const result = flattenSchema({
      name: 'string',
      address: {
        city: 'string',
        zip: 'number',
      },
      active: 'boolean',
    })
    expect(result).toEqual({
      name: 'string',
      'address.city': 'string',
      'address.zip': 'number',
      active: 'boolean',
    })
  })

  it('preserves vector and array types', () => {
    const result = flattenSchema({
      embedding: 'vector[128]',
      tags: 'string[]',
      location: 'geopoint',
    })
    expect(result).toEqual({
      embedding: 'vector[128]',
      tags: 'string[]',
      location: 'geopoint',
    })
  })

  it('returns an empty object for an empty schema', () => {
    expect(flattenSchema({})).toEqual({})
  })
})

describe('validateDocumentStrict', () => {
  const schema = {
    title: 'string' as const,
    price: 'number' as const,
    address: {
      street: 'string' as const,
      city: 'string' as const,
    },
  }

  it('rejects document with extra top-level fields', () => {
    try {
      validateDocumentStrict({ title: 'Laptop', price: 999, brand: 'Acme' }, schema)
      expect.fail('Expected validation error')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
      expect((err as NarsilError).message).toContain('brand')
    }
  })

  it('allows document matching schema exactly', () => {
    const doc = { title: 'Laptop', price: 999, address: { street: '123 Main St', city: 'Accra' } }
    expect(() => validateDocumentStrict(doc, schema)).not.toThrow()
  })

  it('allows id field even when not in schema', () => {
    expect(() => {
      validateDocumentStrict({ id: 'custom-id', title: 'Laptop', price: 999 }, schema)
    }).not.toThrow()
  })

  it('checks nested objects recursively', () => {
    try {
      validateDocumentStrict(
        { title: 'Laptop', price: 999, address: { street: '123 Main', city: 'Accra', zip: '10001' } },
        schema,
      )
      expect.fail('Expected validation error')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).message).toContain('address.zip')
    }
  })

  it('allows documents with only some schema fields', () => {
    expect(() => {
      validateDocumentStrict({ title: 'Laptop' }, schema)
    }).not.toThrow()
  })
})
