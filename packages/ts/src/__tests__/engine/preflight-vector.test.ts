import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { SchemaDefinition } from '../../types/schema'

const DIM = 4

const vectorSchema: SchemaDefinition = {
  title: 'string',
  embedding: `vector[${DIM}]`,
}

const textOnlySchema: SchemaDefinition = {
  title: 'string',
  body: 'string',
}

function vec(lead: number, rest = 0): number[] {
  const v = new Array(DIM).fill(rest)
  v[0] = lead
  return v
}

describe('executePreflight with vector and hybrid queries', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('returns a count for a vector-only query', async () => {
    await narsil.createIndex('docs', { schema: vectorSchema, language: 'english' })
    await narsil.insert('docs', { title: 'alpha', embedding: vec(0.9, 0.1) })
    await narsil.insert('docs', { title: 'beta', embedding: vec(0.1, 0.9) })
    await narsil.insert('docs', { title: 'gamma', embedding: vec(0.5, 0.5) })

    const result = await narsil.preflight('docs', {
      vector: { field: 'embedding', value: vec(1.0, 0.0), metric: 'cosine' },
      limit: 10,
    })

    expect(result.count).toBeGreaterThan(0)
    expect(result.elapsed).toBeGreaterThanOrEqual(0)
  })

  it('returns a fused count for a hybrid query', async () => {
    await narsil.createIndex('docs', { schema: vectorSchema, language: 'english' })
    await narsil.insert('docs', { title: 'wireless headphones', embedding: vec(0.9, 0.1) })
    await narsil.insert('docs', { title: 'cooking recipes', embedding: vec(0.1, 0.9) })

    const result = await narsil.preflight('docs', {
      term: 'wireless',
      vector: { field: 'embedding', value: vec(1.0, 0.0), metric: 'cosine' },
      mode: 'hybrid',
      limit: 10,
    })

    expect(result.count).toBeGreaterThan(0)
    expect(result.elapsed).toBeGreaterThanOrEqual(0)
  })

  it('works for a text-only query as before', async () => {
    await narsil.createIndex('docs', { schema: vectorSchema, language: 'english' })
    await narsil.insert('docs', { title: 'wireless headphones', embedding: vec(0.5, 0.5) })
    await narsil.insert('docs', { title: 'bluetooth speaker', embedding: vec(0.1, 0.9) })

    const result = await narsil.preflight('docs', { term: 'wireless', limit: 10 })

    expect(result.count).toBe(1)
    expect(result.elapsed).toBeGreaterThanOrEqual(0)
  })

  it('falls through to text search when the vector field has no global index', async () => {
    await narsil.createIndex('text-only', { schema: textOnlySchema, language: 'english' })
    await narsil.insert('text-only', { title: 'wireless headphones', body: 'great sound quality' })

    const result = await narsil.preflight('text-only', {
      term: 'wireless',
      vector: { field: 'nonexistent_field', value: [1, 2, 3], metric: 'cosine' },
      limit: 10,
    })

    expect(result.count).toBe(1)
    expect(result.elapsed).toBeGreaterThanOrEqual(0)
  })
})
