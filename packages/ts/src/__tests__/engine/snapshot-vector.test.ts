import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { SchemaDefinition } from '../../types/schema'

const DIM = 4

const schema: SchemaDefinition = {
  title: 'string',
  embedding: `vector[${DIM}]`,
}

function vec(lead: number, rest = 0): number[] {
  const v = new Array(DIM).fill(rest)
  v[0] = lead
  return v
}

describe('snapshot and restore with vector data', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('supports vector search after restore', async () => {
    await narsil.createIndex('docs', { schema, language: 'english' })
    await narsil.insert('docs', { title: 'near', embedding: vec(0.95, 0.05) }, 'near')
    await narsil.insert('docs', { title: 'far', embedding: vec(0.0, 1.0) }, 'far')

    const snapshotData = await narsil.snapshot('docs')
    await narsil.dropIndex('docs')
    await narsil.restore('docs', snapshotData)

    const vectorResult = await narsil.query('docs', {
      vector: { field: 'embedding', value: vec(1.0, 0.0), metric: 'cosine' },
      limit: 1,
    })
    expect(vectorResult.hits).toHaveLength(1)
    expect(vectorResult.hits[0].id).toBe('near')
  })
})
