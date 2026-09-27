import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { SchemaDefinition } from '../../types/schema'

const schema: SchemaDefinition = { title: 'string', body: 'string' }

const WORKERS_OFF = { workers: { enabled: false } } as const

describe('validating what a write names', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil(WORKERS_OFF)
    await narsil.createIndex('docs', { schema, language: 'english' })
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('refuses a document id that is not a string', async () => {
    const arrayId = ['a', 'b'] as unknown as string

    await expect(narsil.insert('docs', { title: 'one' }, arrayId)).rejects.toMatchObject({
      code: ErrorCodes.DOC_VALIDATION_FAILED,
    })
    await expect(narsil.insert('docs', { title: 'one' }, 7 as unknown as string)).rejects.toMatchObject({
      code: ErrorCodes.DOC_VALIDATION_FAILED,
    })
  })

  it('refuses a docId argument that contradicts the document id field', async () => {
    await expect(narsil.insert('docs', { id: 'from-field', title: 'one' }, 'from-argument')).rejects.toMatchObject({
      code: ErrorCodes.DOC_VALIDATION_FAILED,
    })

    await expect(narsil.insert('docs', { id: 'agreed', title: 'one' }, 'agreed')).resolves.toBe('agreed')
  })

  it('refuses a malformed index name under a configuration code', async () => {
    await expect(narsil.createIndex('sp ace', { schema, language: 'english' })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    })
  })

  it('refuses an update that omits a required field, alone and in a batch', async () => {
    await narsil.createIndex('priced', { schema: { name: 'string', price: 'number' }, required: ['price'] })
    await narsil.insert('priced', { name: 'Urban commuter', price: 700 }, 'urban')

    await expect(narsil.update('priced', 'urban', { name: 'No price' })).rejects.toMatchObject({
      code: ErrorCodes.DOC_MISSING_REQUIRED_FIELD,
    })
    const batch = await narsil.updateBatch('priced', [{ docId: 'urban', document: { name: 'No price' } }])
    expect(batch.succeeded).toEqual([])
    expect(batch.failed[0].error.code).toBe(ErrorCodes.DOC_MISSING_REQUIRED_FIELD)
    expect(await narsil.get('priced', 'urban')).toMatchObject({ price: 700 })
  })

  it('refuses a relative bootstrap module', async () => {
    await expect(createNarsil({ workers: { bootstrapModule: './register.mjs' } })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    })
  })
})
