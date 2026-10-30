import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'

const CONFIG = { schema: { title: 'string', meta: { note: 'string' }, embedding: 'vector[2]' } } as const

function deeplyNested(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let cursor = root
  for (let level = 0; level < depth; level++) {
    const next: Record<string, unknown> = {}
    cursor.n = next
    cursor = next
  }
  return root
}

describe('a document that storage cannot carry', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('notes', CONFIG)
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('refuses each value that would change or vanish in storage, and stores nothing', async () => {
    const circular: Record<string, unknown> = { title: 'x' }
    circular.self = circular
    const indirect: Record<string, unknown> = { title: 'x' }
    indirect.child = { parent: indirect }
    const refused: Array<[string, Record<string, unknown>]> = [
      ['a bigint', { title: 'x', count: BigInt(7) }],
      ['a function', { title: 'x', callback: () => 1 }],
      ['a Map', { title: 'x', lookup: new Map([['k', 'v']]) }],
      ['a Set', { title: 'x', tags: new Set(['a']) }],
      ['a typed array outside a vector field', { title: 'x', raw: new Float32Array([1, 2]) }],
      ['a regular expression', { title: 'x', pattern: /abc/ }],
      ['a class instance', { title: 'x', box: new (class Box {})() }],
      ['a document that holds itself', circular],
      ['a document that holds itself through a child', indirect],
      ['a document nested 40 levels deep', { title: 'x', deep: deeplyNested(40) }],
    ]
    for (const [label, document] of refused) {
      await expect(narsil.insert('notes', document), label).rejects.toMatchObject({
        code: ErrorCodes.DOC_VALIDATION_FAILED,
      })
    }
    expect(await narsil.countDocuments('notes')).toBe(0)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('keeps plain data, dates, bytes, a repeated reference, and a declared vector', async () => {
    const shared = { note: 'shared' }
    const when = new Date(0)
    const id = await narsil.insert('notes', {
      title: 'kept',
      meta: { note: 'fine' },
      embedding: new Float32Array([1, 2]),
      when,
      bytes: new Uint8Array([1, 2, 3]),
      twice: [shared, shared],
      empty: null,
    })
    const stored = await narsil.get('notes', id)
    expect(stored?.title).toBe('kept')
    expect(stored?.when).toEqual(when)
    expect(stored?.twice).toEqual([shared, shared])
    expect(stored?.empty).toBeNull()
  })

  it('refuses a schema whose field name reaches the object prototype, at the top and nested', async () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      for (const schema of [
        JSON.parse(`{"${key}":"string","title":"string"}`),
        JSON.parse(`{"meta":{"${key}":"string"},"title":"string"}`),
      ]) {
        await expect(narsil.createIndex(`reserved-${key}`, { schema }), JSON.stringify(schema)).rejects.toMatchObject({
          code: ErrorCodes.SCHEMA_INVALID_TYPE,
        })
      }
    }
    expect(narsil.listIndexes().map(index => index.name)).toEqual(['notes'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
