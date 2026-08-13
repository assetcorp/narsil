import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { validateDocument, validateSchema } from '../../schema/validator'
import type { SchemaDefinition } from '../../types/schema'

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
      validateSchema({ constructor: 'string', name: 'string' } as unknown as SchemaDefinition)
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
      } as unknown as SchemaDefinition)
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

describe('document storability', () => {
  const schema: SchemaDefinition = { title: 'string', meta: { note: 'string' }, embedding: 'vector[2]' }

  function rejects(document: Record<string, unknown>, fragment: string): void {
    try {
      validateDocument(document, schema)
      expect.unreachable('validateDocument should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
      expect((err as NarsilError).message).toContain(fragment)
    }
  }

  it('rejects reserved keys at the root, nested, and inside arrays', () => {
    rejects(JSON.parse('{"__proto__":{"polluted":1}}'), 'reserved')
    rejects(JSON.parse('{"meta":{"__proto__":{"polluted":1}}}'), 'reserved')
    rejects(JSON.parse('{"tags":[{"constructor":{"x":1}}]}'), 'reserved')
    rejects({ prototype: 1 }, 'reserved')
  })

  it('rejects values the storage codec cannot carry or silently corrupts', () => {
    rejects({ title: 'x', count: BigInt(7) }, 'bigint')
    rejects({ title: 'x', callback: () => 1 }, 'function')
    rejects({ title: 'x', lookup: new Map([['k', 'v']]) }, 'does not survive storage')
    rejects({ title: 'x', tags: new Set(['a']) }, 'does not survive storage')
    rejects({ title: 'x', raw: new Float32Array([1, 2]) }, 'does not survive storage')
    rejects({ title: 'x', pattern: /abc/ }, 'does not survive storage')
    rejects({ title: 'x', box: new (class Box {})() }, 'does not survive storage')
  })

  it('rejects circular references and runaway nesting', () => {
    const circular: Record<string, unknown> = { title: 'x' }
    circular.self = circular
    rejects(circular, 'ancestors')

    const indirect: Record<string, unknown> = { title: 'x' }
    indirect.child = { parent: indirect }
    rejects(indirect, 'ancestors')

    let nested: Record<string, unknown> = {}
    const root = { title: 'x', deep: nested }
    for (let i = 0; i < 40; i++) {
      const next: Record<string, unknown> = {}
      nested.n = next
      nested = next
    }
    rejects(root, 'nests deeper')
  })

  it('accepts plain data, dates, bytes, repeated references, and declared vector fields', () => {
    const sharedLeaf = { note: 'shared' }
    expect(() =>
      validateDocument(
        {
          title: 'ok',
          meta: { note: 'fine' },
          embedding: new Float32Array([1, 2]),
          when: new Date(0),
          bytes: new Uint8Array([1, 2, 3]),
          twice: [sharedLeaf, sharedLeaf],
          empty: null,
          missing: undefined,
          nested: { list: [1, 'two', true, { deep: 'value' }] },
        },
        schema,
      ),
    ).not.toThrow()
  })
})
