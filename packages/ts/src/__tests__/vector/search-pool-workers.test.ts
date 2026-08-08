import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHNSWIndex } from '../../vector/hnsw'
import type { VectorReplicaSnapshot } from '../../vector/replica'
import { createVectorSearchPool, type VectorSearchPool } from '../../vector/search-pool'
import { createVectorStore } from '../../vector/vector-store'

const DIM = 8
const DOC_COUNT = 64

function unitVector(seed: number): Float32Array {
  const vector = new Float32Array(DIM)
  for (let i = 0; i < DIM; i++) {
    vector[i] = Math.sin(seed * (i + 1) * 0.7) + 1.5
  }
  let sumSq = 0
  for (let i = 0; i < DIM; i++) sumSq += vector[i] * vector[i]
  const magnitude = Math.sqrt(sumSq)
  for (let i = 0; i < DIM; i++) vector[i] /= magnitude
  return vector
}

function buildSnapshot(prefix: string): { snapshot: VectorReplicaSnapshot; query: Float32Array; nearest: string } {
  const store = createVectorStore()
  for (let i = 0; i < DOC_COUNT; i++) {
    store.insert(`${prefix}-${i}`, unitVector(i + 1))
  }

  const graph = createHNSWIndex(DIM, store, { m: 16, efConstruction: 100, metric: 'cosine' })
  for (let i = 0; i < DOC_COUNT; i++) {
    graph.insertNode(`${prefix}-${i}`)
  }

  const nearest = `${prefix}-7`
  const query = unitVector(8)

  return {
    snapshot: {
      dimension: DIM,
      quantization: 'none',
      calibration: null,
      store: store.exportSnapshot(),
      graph: graph.exportSnapshot(),
      tombstones: [],
    },
    query,
    nearest,
  }
}

describe('two indexes sharing one pool of real workers', () => {
  let pool: VectorSearchPool | null

  beforeEach(async () => {
    pool = await createVectorSearchPool(2)
  })

  afterEach(async () => {
    await pool?.shutdown()
    pool = null
  })

  it('spawns worker threads that answer each handle from its own replica', async () => {
    expect(pool).not.toBeNull()
    expect(pool?.workerCount).toBe(2)

    const title = buildSnapshot('title')
    const body = buildSnapshot('body')

    await expect(pool?.load('title#1', title.snapshot)).resolves.toBe(true)
    await expect(pool?.load('body#2', body.snapshot)).resolves.toBe(true)

    const titleResults = await pool?.search('title#1', title.query, 5, 'cosine', 0)
    const bodyResults = await pool?.search('body#2', body.query, 5, 'cosine', 0)

    expect(titleResults).toHaveLength(5)
    expect(bodyResults).toHaveLength(5)
    expect(titleResults?.[0].docId).toBe(title.nearest)
    expect(bodyResults?.[0].docId).toBe(body.nearest)
    expect(titleResults?.every(result => result.docId.startsWith('title-'))).toBe(true)
    expect(bodyResults?.every(result => result.docId.startsWith('body-'))).toBe(true)
  }, 60_000)

  it('keeps one replica answering after the other is dropped', async () => {
    const title = buildSnapshot('title')
    const body = buildSnapshot('body')
    await pool?.load('title#1', title.snapshot)
    await pool?.load('body#2', body.snapshot)

    await pool?.drop('title#1')

    await expect(pool?.search('title#1', title.query, 3, 'cosine', 0)).rejects.toThrow(/title#1/)
    const bodyResults = await pool?.search('body#2', body.query, 3, 'cosine', 0)
    expect(bodyResults?.[0].docId).toBe(body.nearest)
  }, 60_000)

  it('answers the same documents the calling thread would', async () => {
    const store = createVectorStore()
    for (let i = 0; i < DOC_COUNT; i++) store.insert(`doc-${i}`, unitVector(i + 1))
    const graph = createHNSWIndex(DIM, store, { m: 16, efConstruction: 100, metric: 'cosine' })
    for (let i = 0; i < DOC_COUNT; i++) graph.insertNode(`doc-${i}`)
    const query = unitVector(8)

    const local = graph.search(query, 5, 'cosine', 0)
    await pool?.load('doc#1', {
      dimension: DIM,
      quantization: 'none',
      calibration: null,
      store: store.exportSnapshot(),
      graph: graph.exportSnapshot(),
      tombstones: [],
    })

    const remote = await pool?.search('doc#1', query, 5, 'cosine', 0)

    expect(remote?.map(result => result.docId)).toEqual(local.map(result => result.docId))
    for (let i = 0; i < local.length; i++) {
      expect(remote?.[i].score).toBeCloseTo(local[i].score, 5)
    }
  }, 60_000)

  it('refuses a search against a handle it never loaded', async () => {
    await expect(pool?.search('missing#9', unitVector(1), 3, 'cosine', 0)).rejects.toThrow(/missing#9/)
  }, 60_000)
})
