import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { SchemaDefinition } from '../../types/schema'

describe('field types with options', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('stores every base type with its options in the order sortable, pattern, partial', async () => {
    const schema = {
      title: 'string:partial:sortable:pattern',
      tags: 'string[]:pattern:sortable',
      summary: 'string:partial',
      code: 'verbatim:sortable',
      paths: 'verbatim[]',
      plain: 'string',
      price: 'number',
      sizes: 'number[]',
      active: 'boolean',
      flags: 'boolean[]',
      kind: 'enum',
      kinds: 'enum[]',
      place: 'geopoint',
      embedding: 'vector[3]',
      author: { name: 'string:pattern:sortable' },
    } as SchemaDefinition

    await narsil.createIndex('catalogue', { schema })

    expect(narsil.getStats('catalogue').schema).toEqual({
      title: 'string:sortable:pattern:partial',
      tags: 'string[]:sortable:pattern',
      summary: 'string:partial',
      code: 'verbatim:sortable',
      paths: 'verbatim[]',
      plain: 'string',
      price: 'number',
      sizes: 'number[]',
      active: 'boolean',
      flags: 'boolean[]',
      kind: 'enum',
      kinds: 'enum[]',
      place: 'geopoint',
      embedding: 'vector[3]',
      author: { name: 'string:sortable:pattern' },
    })
  })

  it('raises SCHEMA_INVALID_TYPE for an unknown base type, an option that the base type does not take, and a repeated option', async () => {
    const invalidTypes = [
      'text',
      'string:fuzzy',
      'verbatim:pattern',
      'verbatim[]:partial',
      'number:sortable',
      'enum:pattern',
      'vector[3]:sortable',
      'string:sortable:sortable',
      'string[]:pattern:partial:pattern',
      'string:',
      'string::sortable',
    ]

    for (const [position, type] of invalidTypes.entries()) {
      await expect(
        narsil.createIndex(`invalid-${position}`, { schema: { field: type } as SchemaDefinition }),
      ).rejects.toMatchObject({ code: ErrorCodes.SCHEMA_INVALID_TYPE, details: { field: 'field', type } })
    }
    expect(narsil.listIndexes()).toEqual([])
  })

  it('keeps a verbatim value whole, so a keyword search skips it while a filter matches it exactly', async () => {
    await narsil.createIndex('invoices', { schema: { title: 'string', code: 'verbatim', paths: 'verbatim[]' } })
    await narsil.insert('invoices', { title: 'March invoice', code: 'INV-2024 March', paths: ['/srv/a b'] }, 'a')
    await narsil.insert('invoices', { title: 'April invoice', code: 'inv-2024 march', paths: ['/srv/c'] }, 'b')

    expect((await narsil.query('invoices', { term: 'march' })).hits.map(hit => hit.id)).toEqual(['a'])
    expect((await narsil.query('invoices', { term: 'inv' })).hits).toEqual([])
    await expect(narsil.query('invoices', { term: 'march', fields: ['code'] })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_FIELD,
    })

    const exact = await narsil.query('invoices', {
      term: 'invoice',
      filters: { fields: { code: { eq: 'INV-2024 March' } } },
    })
    expect(exact.hits.map(hit => hit.id)).toEqual(['a'])
    const listed = await narsil.query('invoices', {
      term: 'invoice',
      filters: { fields: { paths: { in: ['/srv/a b'] } } },
    })
    expect(listed.hits.map(hit => hit.id)).toEqual(['a'])

    await expect(narsil.insert('invoices', { title: 'May', code: 42 }, 'c')).rejects.toMatchObject({
      code: ErrorCodes.DOC_VALIDATION_FAILED,
    })
    await expect(narsil.insert('invoices', { title: 'May', paths: ['/srv', 7] }, 'c')).rejects.toMatchObject({
      code: ErrorCodes.DOC_VALIDATION_FAILED,
    })
  })
})
