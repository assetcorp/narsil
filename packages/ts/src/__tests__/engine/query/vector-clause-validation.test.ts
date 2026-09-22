import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { SchemaDefinition } from '../../../types/schema'

const schema: SchemaDefinition = { title: 'string', body: 'string' }
const vectorSchema: SchemaDefinition = { title: 'string', embedding: 'vector[4]' }

const WORKERS_OFF = { workers: { enabled: false } } as const

describe('a search that names a vector field with no vector index', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil(WORKERS_OFF)
    await narsil.createIndex('docs', { schema, language: 'english' })
    await narsil.insert('docs', { title: 'wireless headphones', body: 'great sound' })
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('refuses a hybrid query, where it once answered with keyword hits alone', async () => {
    await expect(
      narsil.query('docs', {
        term: 'wireless',
        mode: 'hybrid',
        vector: { field: 'embedding', value: [1, 0, 0, 0] },
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.SEARCH_INVALID_FIELD })
  })

  it('refuses a vector query that names no vector clause', async () => {
    await expect(narsil.query('docs', { mode: 'vector' })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_MODE,
    })
  })

  it('refuses a mode the engine does not define', async () => {
    await expect(narsil.query('docs', { term: 'wireless', mode: 'psychic' as never })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_MODE,
    })
  })
})

describe('a query vector of the wrong length', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil(WORKERS_OFF)
    await narsil.createIndex('docs', { schema: vectorSchema, language: 'english' })
    await narsil.insert('docs', { title: 'one', embedding: [1, 0, 0, 0] })
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('answers with the dimension mismatch code, where it once threw a bare error', async () => {
    await expect(
      narsil.query('docs', { mode: 'vector', vector: { field: 'embedding', value: [1, 0] } }),
    ).rejects.toMatchObject({ code: ErrorCodes.VECTOR_DIMENSION_MISMATCH })
  })
})
