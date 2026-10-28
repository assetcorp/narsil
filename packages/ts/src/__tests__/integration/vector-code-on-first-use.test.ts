import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SchemaDefinition } from '../../types/schema'
import { bytesOf } from '../e2e/portability/archive-oracle'

const DIMENSION = 8
const DOCUMENT_COUNT = 60
const RESULT_LIMIT = 5
const SCHEMA: SchemaDefinition = { title: 'string', embedding: `vector[${DIMENSION}]` }

type EngineModule = typeof import('../../index')
type VectorCodeModule = typeof import('../../workers/vector-code')

interface FreshEngine {
  engine: EngineModule
  vectorCode: VectorCodeModule
  filesystem: typeof import('../../persistence/filesystem')
}

async function freshEngine(): Promise<FreshEngine> {
  vi.resetModules()
  const [engine, vectorCode, filesystem] = await Promise.all([
    import('../../index'),
    import('../../workers/vector-code'),
    import('../../persistence/filesystem'),
  ])
  return { engine, vectorCode, filesystem }
}

function seededVectors(seed: number): number[][] {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5
  }
  return Array.from({ length: DOCUMENT_COUNT }, () => Array.from({ length: DIMENSION }, next))
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / Math.sqrt(normA * normB)
}

function nearestByOracle(vectors: number[][], query: number[]): string[] {
  return vectors
    .map((vector, i) => ({ id: `doc-${i}`, score: cosine(vector, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, RESULT_LIMIT)
    .map(hit => hit.id)
}

async function nearestByEngine(narsil: Awaited<ReturnType<EngineModule['createNarsil']>>, query: number[]) {
  const result = await narsil.query('images', {
    vector: { field: 'embedding', value: query, metric: 'cosine' },
    limit: RESULT_LIMIT,
  })
  return result.hits.map(hit => hit.id)
}

async function fillImages(narsil: Awaited<ReturnType<EngineModule['createNarsil']>>, vectors: number[][]) {
  await narsil.createIndex('images', { schema: SCHEMA, language: 'english' })
  for (let i = 0; i < vectors.length; i++) {
    await narsil.insert('images', { title: `image ${i}`, embedding: vectors[i] }, `doc-${i}`)
  }
}

describe('vector code that the engine loads on first use', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-vector-code-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('restores a vector snapshot into an engine that has loaded no vector code', async () => {
    const vectors = seededVectors(11)
    const query = seededVectors(97)[0]
    const writer = await freshEngine()
    const source = await writer.engine.createNarsil({ workers: { enabled: false } })
    await fillImages(source, vectors)
    const snapshot = await bytesOf(await source.snapshot('images'))
    await source.shutdown()

    const reader = await freshEngine()
    expect(reader.vectorCode.loadedVectorCode()).toBeNull()
    const target = await reader.engine.createNarsil({ workers: { enabled: false } })
    try {
      await target.createIndex('notes', { schema: { body: 'string' } })
      expect(reader.vectorCode.loadedVectorCode()).toBeNull()
      await target.restore('images', snapshot)
      expect(reader.vectorCode.loadedVectorCode()).not.toBeNull()
      expect(await target.countDocuments('images')).toBe(DOCUMENT_COUNT)
      expect(await nearestByEngine(target, query)).toEqual(nearestByOracle(vectors, query))
    } finally {
      await target.shutdown()
    }
  })

  it('recovers a durable vector index into an engine that has loaded no vector code', async () => {
    const vectors = seededVectors(23)
    const query = seededVectors(5)[3]
    const writer = await freshEngine()
    const source = await writer.engine.createNarsil({
      workers: { enabled: false },
      persistence: writer.filesystem.createFilesystemPersistence({ directory: root }),
    })
    await fillImages(source, vectors)
    await source.shutdown()

    const reader = await freshEngine()
    expect(reader.vectorCode.loadedVectorCode()).toBeNull()
    const target = await reader.engine.createNarsil({
      workers: { enabled: false },
      persistence: reader.filesystem.createFilesystemPersistence({ directory: root }),
    })
    try {
      expect(reader.vectorCode.loadedVectorCode()).not.toBeNull()
      expect(await target.countDocuments('images')).toBe(DOCUMENT_COUNT)
      expect(await nearestByEngine(target, query)).toEqual(nearestByOracle(vectors, query))
    } finally {
      await target.shutdown()
    }
  })

  it('creates one index when two calls race for the same vector index name during the first load', async () => {
    const { engine, vectorCode } = await freshEngine()
    const narsil = await engine.createNarsil({ workers: { enabled: false } })
    try {
      expect(vectorCode.loadedVectorCode()).toBeNull()
      const outcomes = await Promise.allSettled([
        narsil.createIndex('images', { schema: SCHEMA }),
        narsil.createIndex('images', { schema: SCHEMA }),
      ])
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
      const rejected = outcomes.find(outcome => outcome.status === 'rejected')
      expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toMatchObject({
        code: 'INDEX_ALREADY_EXISTS',
      })
      await narsil.insert('images', { title: 'first', embedding: seededVectors(3)[0] }, 'doc-0')
      expect(await narsil.countDocuments('images')).toBe(1)
    } finally {
      await narsil.shutdown()
    }
  })

  it('rejects a malformed vector schema with the same error before and after the code loads', async () => {
    const { engine } = await freshEngine()
    const narsil = await engine.createNarsil({ workers: { enabled: false } })
    try {
      const malformed = { schema: { embedding: 'vector[0]' as const } }
      await expect(narsil.createIndex('broken', malformed)).rejects.toMatchObject({
        code: 'SCHEMA_INVALID_VECTOR_DIMENSION',
      })
      await narsil.createIndex('images', { schema: SCHEMA })
      await expect(narsil.createIndex('broken', malformed)).rejects.toMatchObject({
        code: 'SCHEMA_INVALID_VECTOR_DIMENSION',
      })
      expect(await narsil.listIndexes()).toEqual([expect.objectContaining({ name: 'images' })])
    } finally {
      await narsil.shutdown()
    }
  })
})
