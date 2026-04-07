import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { validateSchema } from '../../schema/validator'

describe('prototype pollution protection in schema validation', () => {
  it('rejects __proto__ as a field name from parsed JSON', () => {
    const malicious = JSON.parse('{"__proto__":"string","name":"string"}')
    try {
      validateSchema(malicious)
      expect.fail('Expected NarsilError')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.SCHEMA_INVALID_TYPE)
      expect((err as NarsilError).message).toContain('__proto__')
    }
  })

  it('rejects constructor as a field name', () => {
    try {
      validateSchema({ constructor: 'string', name: 'string' })
      expect.fail('Expected NarsilError')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.SCHEMA_INVALID_TYPE)
      expect((err as NarsilError).message).toContain('constructor')
    }
  })

  it('rejects prototype as a field name', () => {
    try {
      validateSchema({ prototype: 'string', name: 'string' })
      expect.fail('Expected NarsilError')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.SCHEMA_INVALID_TYPE)
      expect((err as NarsilError).message).toContain('prototype')
    }
  })

  it('rejects __proto__ nested inside an object field from parsed JSON', () => {
    const malicious = JSON.parse('{"metadata":{"__proto__":"string"}}')
    try {
      validateSchema(malicious)
      expect.fail('Expected NarsilError')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.SCHEMA_INVALID_TYPE)
    }
  })

  it('rejects constructor nested inside an object field', () => {
    try {
      validateSchema({
        metadata: {
          constructor: 'number',
        },
      })
      expect.fail('Expected NarsilError')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.SCHEMA_INVALID_TYPE)
    }
  })

  it('rejects prototype nested inside an object field', () => {
    try {
      validateSchema({
        config: {
          prototype: 'boolean',
        },
      })
      expect.fail('Expected NarsilError')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.SCHEMA_INVALID_TYPE)
    }
  })

  it('accepts schemas with normal field names', () => {
    expect(() =>
      validateSchema({
        title: 'string',
        price: 'number',
        active: 'boolean',
        metadata: {
          author: 'string',
        },
      }),
    ).not.toThrow()
  })
})
