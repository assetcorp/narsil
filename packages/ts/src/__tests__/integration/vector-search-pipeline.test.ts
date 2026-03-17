import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'

const DIM = 8

const schema: SchemaDefinition = {
  title: 'string',
  embedding: `vector[${DIM}]`,
}

const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

function paddedVector(lead: number, rest = 0): number[] {
  const v = new Array(DIM).fill(rest)
  v[0] = lead
  return v
}

function randomVector(): number[] {
  const v: number[] = []
  for (let i = 0; i < DIM; i++) {
    v.push(Math.random() * 2 - 1)
  }
  return v
}

describe('vector search through Narsil query API', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('docs', indexConfig)
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('returns nearest vectors sorted by similarity', async () => {
    await narsil.insert('docs', { title: 'close match', embedding: paddedVector(0.95, 0.05) }, 'near')
    await narsil.insert('docs', { title: 'medium match', embedding: paddedVector(0.5, 0.5) }, 'mid')
    await narsil.insert('docs', { title: 'far away', embedding: paddedVector(0.0, 1.0) }, 'far')

    const result = await narsil.query('docs', {
      vector: { field: 'embedding', value: paddedVector(1.0, 0.0), metric: 'cosine' },
      limit: 2,
    })

    expect(result.hits).toHaveLength(2)
    expect(result.hits[0].id).toBe('near')
    expect(result.hits[1].id).toBe('mid')
    expect(result.hits[0].score).toBeGreaterThan(result.hits[1].score)
  })

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 20; i++) {
      await narsil.insert('docs', { title: `doc ${i}`, embedding: randomVector() })
    }

    const result = await narsil.query('docs', {
      vector: { field: 'embedding', value: randomVector() },
      limit: 5,
    })

    expect(result.hits).toHaveLength(5)
  })

  it('filters by minimum similarity threshold', async () => {
    await narsil.insert('docs', { title: 'very close', embedding: paddedVector(0.99, 0.01) }, 'close')
    await narsil.insert('docs', { title: 'opposite direction', embedding: paddedVector(-1.0, 0.0) }, 'opposite')

    const result = await narsil.query('docs', {
      vector: {
        field: 'embedding',
        value: paddedVector(1.0, 0.0),
        metric: 'cosine',
        similarity: 0.8,
      },
      limit: 10,
    })

    const ids = result.hits.map(h => h.id)
    expect(ids).toContain('close')
    expect(ids).not.toContain('opposite')
  })

  it('passes efSearch through the query pipeline', async () => {
    for (let i = 0; i < 30; i++) {
      await narsil.insert('docs', { title: `doc ${i}`, embedding: randomVector() })
    }

    const result = await narsil.query('docs', {
      vector: {
        field: 'embedding',
        value: randomVector(),
        efSearch: 200,
      },
      limit: 5,
    })

    expect(result.hits.length).toBeLessThanOrEqual(5)
    expect(result.hits.length).toBeGreaterThan(0)
  })

  it('supports euclidean metric through the API', async () => {
    await narsil.insert('docs', { title: 'origin adjacent', embedding: paddedVector(0.1, 0.0) }, 'close')
    await narsil.insert('docs', { title: 'far from origin', embedding: paddedVector(10.0, 10.0) }, 'far')

    const result = await narsil.query('docs', {
      vector: {
        field: 'embedding',
        value: paddedVector(0.0, 0.0),
        metric: 'euclidean',
      },
      limit: 1,
    })

    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].id).toBe('close')
  })

  it('returns results in hybrid mode combining text and vector', async () => {
    await narsil.insert(
      'docs',
      { title: 'wireless headphones review', embedding: paddedVector(0.9, 0.1) },
      'text-and-vec',
    )
    await narsil.insert('docs', { title: 'cooking recipes', embedding: paddedVector(0.95, 0.05) }, 'vec-only')
    await narsil.insert('docs', { title: 'wireless charger guide', embedding: paddedVector(0.0, 1.0) }, 'text-only')

    const result = await narsil.query('docs', {
      term: 'wireless',
      vector: { field: 'embedding', value: paddedVector(1.0, 0.0) },
      mode: 'hybrid',
      hybrid: { alpha: 0.5 },
      limit: 3,
    })

    expect(result.hits.length).toBeGreaterThan(0)
    const ids = result.hits.map(h => h.id)
    expect(ids).toContain('text-and-vec')
  })
})
