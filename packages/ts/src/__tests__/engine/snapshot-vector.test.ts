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

  it('preserves documents and vectors through a snapshot/restore round-trip', async () => {
    await narsil.createIndex('docs', { schema, language: 'english' })

    await narsil.insert('docs', { title: 'alpha', embedding: vec(0.9, 0.1) }, 'id-alpha')
    await narsil.insert('docs', { title: 'beta', embedding: vec(0.1, 0.9) }, 'id-beta')

    const snapshotData = await narsil.snapshot('docs')
    expect(snapshotData).toBeInstanceOf(Uint8Array)
    expect(snapshotData.byteLength).toBeGreaterThan(0)

    await narsil.dropIndex('docs')

    await narsil.restore('docs', snapshotData)

    const docAlpha = await narsil.get('docs', 'id-alpha')
    expect(docAlpha).toBeDefined()
    expect(docAlpha?.title).toBe('alpha')

    const docBeta = await narsil.get('docs', 'id-beta')
    expect(docBeta).toBeDefined()
    expect(docBeta?.title).toBe('beta')
  })

  it('supports text search after restore', async () => {
    await narsil.createIndex('docs', { schema, language: 'english' })
    await narsil.insert('docs', { title: 'wireless headphones', embedding: vec(0.8, 0.2) }, 'wh')
    await narsil.insert('docs', { title: 'bluetooth speaker', embedding: vec(0.2, 0.8) }, 'bs')

    const snapshotData = await narsil.snapshot('docs')
    await narsil.dropIndex('docs')
    await narsil.restore('docs', snapshotData)

    const textResult = await narsil.query('docs', { term: 'wireless', limit: 10 })
    expect(textResult.hits).toHaveLength(1)
    expect(textResult.hits[0].id).toBe('wh')
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

  it('handles restore of a v1 snapshot without vectorIndexes field gracefully', async () => {
    await narsil.createIndex('docs', { schema: { title: 'string' }, language: 'english' })
    await narsil.insert('docs', { title: 'test document' }, 'doc-1')

    const snapshotData = await narsil.snapshot('docs')
    await narsil.dropIndex('docs')

    await narsil.restore('docs', snapshotData)

    const doc = await narsil.get('docs', 'doc-1')
    expect(doc).toBeDefined()
    expect(doc?.title).toBe('test document')
  })
})
