import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import { deserializeMetadata, serializeMetadata } from '../../../serialization/payload-v1'
import type { EmbeddingAdapter } from '../../../types/adapters'
import type { IndexMetadata } from '../../../types/internal'
import type { IndexConfig } from '../../../types/schema'

const DIMENSIONS = 4

interface CountingAdapter {
  adapter: EmbeddingAdapter
  counts: { document: number; query: number }
}

/** Deterministic adapter: the same text always produces the same unit vector,
 * so a query for an indexed title must rank that document first. */
function countingAdapter(dimensions = DIMENSIONS): CountingAdapter {
  const counts = { document: 0, query: 0 }
  const adapter: EmbeddingAdapter = {
    dimensions,
    async embed(input: string, purpose: 'document' | 'query'): Promise<Float32Array> {
      counts[purpose] += 1
      const vector = new Float32Array(dimensions)
      for (let i = 0; i < input.length; i += 1) {
        vector[i % dimensions] += input.charCodeAt(i)
      }
      let norm = 0
      for (const component of vector) norm += component * component
      norm = Math.sqrt(norm) || 1
      for (let i = 0; i < dimensions; i += 1) vector[i] /= norm
      return vector
    },
  }
  return { adapter, counts }
}

const INDEX_CONFIG: IndexConfig = {
  schema: { title: 'string', body: 'string', embedding: `vector[${DIMENSIONS}]` },
  embedding: { adapter: 'stub', fields: { embedding: ['title'] } },
}

const DOCS = [
  { id: 'a', title: 'volcanic islands of the pacific', body: 'basalt and ash' },
  { id: 'b', title: 'medieval trade routes in europe', body: 'salt and silk' },
  { id: 'c', title: 'deep sea bioluminescence', body: 'light without sun' },
]

describe('durability recovery of embedding configuration', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-embed-recovery-'))
  })

  afterEach(async () => {
    if (engine) {
      await engine.shutdown()
      engine = null
    }
    await rm(dir, { recursive: true, force: true })
  })

  async function seedIndex(): Promise<CountingAdapter> {
    const stub = countingAdapter()
    engine = await createNarsil({
      durability: { directory: dir },
      embeddingAdapters: { stub: stub.adapter },
    })
    await engine.createIndex('articles', INDEX_CONFIG)
    const result = await engine.insertBatch('articles', DOCS)
    expect(result.failed).toHaveLength(0)
    await engine.shutdown()
    engine = null
    return stub
  }

  it('rebinds the adapter at recovery and never re-embeds stored documents', async () => {
    const seedStub = await seedIndex()
    expect(seedStub.counts.document).toBe(DOCS.length)

    const freshStub = countingAdapter()
    engine = await createNarsil({
      durability: { directory: dir },
      embeddingAdapters: { stub: freshStub.adapter },
    })

    expect(engine.listIndexes().map(info => info.name)).toContain('articles')
    expect(await engine.countDocuments('articles')).toBe(DOCS.length)
    expect(freshStub.counts.document).toBe(0)

    const semantic = await engine.query('articles', {
      mode: 'vector',
      vector: { field: 'embedding', text: 'deep sea bioluminescence' },
      limit: 1,
    })
    expect(semantic.hits[0]?.id).toBe('c')
    expect(freshStub.counts.query).toBe(1)
    expect(freshStub.counts.document).toBe(0)

    await engine.insert('articles', { id: 'd', title: 'desert dune formation', body: 'wind and sand' })
    expect(freshStub.counts.document).toBe(1)
    expect(await engine.countDocuments('articles')).toBe(4)

    const keyword = await engine.query('articles', { term: 'basalt', limit: 1 })
    expect(keyword.hits[0]?.id).toBe('a')
  })

  it('recovers without the adapter, degrades loudly, and rebinds on registration', async () => {
    await seedIndex()

    engine = await createNarsil({ durability: { directory: dir } })

    const keyword = await engine.query('articles', { term: 'silk', limit: 1 })
    expect(keyword.hits[0]?.id).toBe('b')

    await expect(
      engine.query('articles', { mode: 'vector', vector: { field: 'embedding', text: 'trade routes' }, limit: 1 }),
    ).rejects.toMatchObject({ code: ErrorCodes.EMBEDDING_CONFIG_INVALID, message: expect.stringContaining('"stub"') })

    await expect(
      engine.insert('articles', { id: 'e', title: 'auroras at high latitude', body: 'charged particles' }),
    ).rejects.toMatchObject({ code: ErrorCodes.EMBEDDING_CONFIG_INVALID, message: expect.stringContaining('"stub"') })

    const batch = await engine.insertBatch('articles', [{ id: 'f', title: 'glacier retreat', body: 'ice and time' }])
    expect(batch.succeeded).toHaveLength(0)
    expect(batch.failed[0]?.docId).toBe('f')
    expect(batch.failed[0]?.error.message).toContain('"stub"')

    const ownVector = new Float32Array(DIMENSIONS).fill(0.5)
    await engine.insert('articles', {
      id: 'g',
      title: 'brought my own vector',
      body: 'no adapter needed',
      embedding: Array.from(ownVector),
    })
    expect(await engine.countDocuments('articles')).toBe(DOCS.length + 1)

    const lateStub = countingAdapter()
    engine.registerEmbeddingAdapter('stub', lateStub.adapter)

    const semantic = await engine.query('articles', {
      mode: 'vector',
      vector: { field: 'embedding', text: 'volcanic islands of the pacific' },
      limit: 1,
    })
    expect(semantic.hits[0]?.id).toBe('a')
    expect(lateStub.counts.query).toBe(1)

    await engine.insert('articles', { id: 'h', title: 'river delta sediment', body: 'silt and flow' })
    expect(lateStub.counts.document).toBe(1)
  })

  it('refuses to rebind an adapter whose dimensions no longer match', async () => {
    await seedIndex()

    engine = await createNarsil({ durability: { directory: dir } })

    const wrongDimensions = countingAdapter(8)
    expect(() => {
      if (!engine) throw new Error('engine missing')
      engine.registerEmbeddingAdapter('stub', wrongDimensions.adapter)
    }).toThrowError(
      expect.objectContaining({
        code: ErrorCodes.EMBEDDING_DIMENSION_MISMATCH,
        message: expect.stringContaining('articles'),
      }),
    )

    // The failed registration must leave the registry untouched.
    await expect(
      engine.query('articles', { mode: 'vector', vector: { field: 'embedding', text: 'anything' }, limit: 1 }),
    ).rejects.toMatchObject({ code: ErrorCodes.EMBEDDING_CONFIG_INVALID })

    const correct = countingAdapter()
    engine.registerEmbeddingAdapter('stub', correct.adapter)
    const semantic = await engine.query('articles', {
      mode: 'vector',
      vector: { field: 'embedding', text: 'medieval trade routes in europe' },
      limit: 1,
    })
    expect(semantic.hits[0]?.id).toBe('b')
  })

  it('fails recovery when the registered adapter dimensions contradict the stored schema', async () => {
    await seedIndex()

    const wrongDimensions = countingAdapter(8)
    await expect(
      createNarsil({ durability: { directory: dir }, embeddingAdapters: { stub: wrongDimensions.adapter } }),
    ).rejects.toMatchObject({
      code: ErrorCodes.EMBEDDING_DIMENSION_MISMATCH,
      message: expect.stringContaining('articles'),
    })
  })

  it('rejects createIndex with an unregistered adapter name and lists what exists', async () => {
    engine = await createNarsil({ embeddingAdapters: { stub: countingAdapter().adapter } })
    try {
      await engine.createIndex('articles', {
        ...INDEX_CONFIG,
        embedding: { adapter: 'missing', fields: { embedding: ['title'] } },
      })
      expect.unreachable('createIndex must throw for an unknown adapter name')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.EMBEDDING_CONFIG_INVALID)
      expect((err as NarsilError).message).toContain('"missing"')
      expect((err as NarsilError).details).toMatchObject({ available: ['stub'] })
    }
  })
})

describe('metadata payload embedding block', () => {
  const base: IndexMetadata = {
    indexName: 'articles',
    schema: { title: 'string', embedding: `vector[${DIMENSIONS}]` },
    language: 'english',
    partitionCount: 1,
    bm25Params: { k1: 1.2, b: 0.75 },
    createdAt: 1,
    engineVersion: '0.0.0-test',
  }

  it('round-trips the adapter name and field mappings', () => {
    const meta: IndexMetadata = {
      ...base,
      embedding: { adapter: 'stub', fields: { embedding: ['title'] } },
    }
    expect(deserializeMetadata(serializeMetadata(meta)).embedding).toEqual({
      adapter: 'stub',
      fields: { embedding: ['title'] },
    })
  })

  it('round-trips a mapping without an adapter name', () => {
    const meta: IndexMetadata = { ...base, embedding: { fields: { embedding: 'title' } } }
    const decoded = deserializeMetadata(serializeMetadata(meta))
    expect(decoded.embedding).toEqual({ fields: { embedding: 'title' } })
    expect(decoded.embedding?.adapter).toBeUndefined()
  })

  it('decodes payloads written before the embedding block existed', () => {
    const decoded = deserializeMetadata(serializeMetadata(base))
    expect(decoded.embedding).toBeUndefined()
    expect(decoded.indexName).toBe('articles')
  })
})
