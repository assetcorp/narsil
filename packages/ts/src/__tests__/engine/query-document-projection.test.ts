import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { SchemaDefinition } from '../../types/schema'

const DIM = 4

const vectorSchema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  embedding: `vector[${DIM}]`,
}

const nestedSchema: SchemaDefinition = {
  title: 'string',
  author: { name: 'string', email: 'string' },
}

function vec(lead: number, rest = 0): number[] {
  const v = new Array(DIM).fill(rest)
  v[0] = lead
  return v
}

describe('document projection', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('returns the whole stored document when the query asks for nothing', async () => {
    await narsil.createIndex('docs', { schema: vectorSchema, language: 'english' })
    await narsil.insert('docs', { title: 'alpha', body: 'searchable text', embedding: vec(0.9) })

    const result = await narsil.query('docs', { term: 'searchable' })

    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].document.title).toBe('alpha')
    expect(result.hits[0].document.embedding).toBeDefined()
  })

  it('returns an empty document for every hit when document is false', async () => {
    await narsil.createIndex('docs', { schema: vectorSchema, language: 'english' })
    await narsil.insert('docs', { title: 'alpha', body: 'searchable text', embedding: vec(0.9) })

    const result = await narsil.query('docs', { term: 'searchable', document: false })

    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].id).toBeDefined()
    expect(result.hits[0].score).toBeGreaterThan(0)
    expect(result.hits[0].document).toEqual({})
  })

  it('keeps only the named fields when include is set', async () => {
    await narsil.createIndex('docs', { schema: vectorSchema, language: 'english' })
    await narsil.insert('docs', { title: 'alpha', body: 'searchable text', embedding: vec(0.9) })

    const result = await narsil.query('docs', { term: 'searchable', document: { include: ['title'] } })

    expect(result.hits[0].document).toEqual({ title: 'alpha' })
  })

  it('drops the named fields when exclude is set and keeps the rest', async () => {
    await narsil.createIndex('docs', { schema: vectorSchema, language: 'english' })
    await narsil.insert('docs', { title: 'alpha', body: 'searchable text', embedding: vec(0.9) })

    const result = await narsil.query('docs', { term: 'searchable', document: { exclude: ['embedding'] } })

    expect(result.hits[0].document.title).toBe('alpha')
    expect(result.hits[0].document.body).toBe('searchable text')
    expect(result.hits[0].document.embedding).toBeUndefined()
  })

  it('drops a vector field from a similarity search without touching the ranking', async () => {
    await narsil.createIndex('docs', { schema: vectorSchema, language: 'english' })
    await narsil.insert('docs', { title: 'alpha', body: 'first', embedding: vec(0.9, 0.1) })
    await narsil.insert('docs', { title: 'beta', body: 'second', embedding: vec(0.1, 0.9) })

    const full = await narsil.query('docs', {
      mode: 'vector',
      vector: { field: 'embedding', value: vec(1.0), metric: 'cosine' },
      limit: 2,
    })
    const projected = await narsil.query('docs', {
      mode: 'vector',
      vector: { field: 'embedding', value: vec(1.0), metric: 'cosine' },
      limit: 2,
      document: { exclude: ['embedding'] },
    })

    expect(projected.hits.map(hit => hit.id)).toEqual(full.hits.map(hit => hit.id))
    expect(full.hits[0].document.embedding).toBeDefined()
    expect(projected.hits[0].document.embedding).toBeUndefined()
    expect(projected.hits[0].document.title).toBe('alpha')
  })

  it('addresses a nested field through dots', async () => {
    await narsil.createIndex('docs', { schema: nestedSchema, language: 'english' })
    await narsil.insert('docs', {
      title: 'alpha',
      author: { name: 'ama', email: 'ama@example.com' },
    })

    const result = await narsil.query('docs', { term: 'alpha', document: { exclude: ['author.email'] } })

    const author = result.hits[0].document.author as Record<string, unknown>
    expect(author.name).toBe('ama')
    expect(author.email).toBeUndefined()
    expect(result.hits[0].document.title).toBe('alpha')
  })

  it('leaves the stored document untouched when a projection drops a field', async () => {
    await narsil.createIndex('docs', { schema: nestedSchema, language: 'english' })
    await narsil.insert('docs', {
      id: 'doc-1',
      title: 'alpha',
      author: { name: 'ama', email: 'ama@example.com' },
    })

    await narsil.query('docs', { term: 'alpha', document: { exclude: ['author.email'] } })
    const stored = await narsil.get('docs', 'doc-1')

    const author = stored?.author as Record<string, unknown>
    expect(author.email).toBe('ama@example.com')
  })

  it('ignores a name that matches no field', async () => {
    await narsil.createIndex('docs', { schema: nestedSchema, language: 'english' })
    await narsil.insert('docs', { title: 'alpha', author: { name: 'ama', email: 'ama@example.com' } })

    const result = await narsil.query('docs', { term: 'alpha', document: { exclude: ['missing'] } })

    expect(result.hits[0].document.title).toBe('alpha')
  })

  it('never writes through a prototype key a projection names', async () => {
    await narsil.createIndex('docs', { schema: nestedSchema, language: 'english' })
    const hostile = JSON.parse('{"title":"alpha","__proto__":{"polluted":"yes"}}')
    await narsil.insert('docs', hostile, 'doc-1')

    const result = await narsil.query('docs', { term: 'alpha', document: { include: ['__proto__.polluted'] } })

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(result.hits[0].document).toEqual({})
  })
})
