import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHNSWIndex, type SerializedHNSWGraph } from '../../../vector/hnsw'
import { createVectorSearchPool, type VectorSearchPool } from '../../../vector/search-pool'
import type { SharedVectorFieldHandles } from '../../../vector/shared-field/types'
import { createVectorStore } from '../../../vector/vector-store'

const DIMENSION = 64
const DOC_COUNT = 3000
const WORKER_COUNT = 4
const INSERT_CHUNK = 32
const ROUNDS = 3

function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function nextVector(next: () => number): Float32Array {
  const vector = new Float32Array(DIMENSION)
  for (let component = 0; component < DIMENSION; component++) vector[component] = next() - 0.5
  return vector
}

function unreachableNodes(graph: SerializedHNSWGraph): string[] {
  const outgoing = new Map<string, string[]>()
  for (const [docId, , layers] of graph.nodes) outgoing.set(docId, new Map(layers).get(0) ?? [])
  if (graph.entryPoint === null) return [...outgoing.keys()]
  const reached = new Set<string>([graph.entryPoint])
  const queue = [graph.entryPoint]
  while (queue.length > 0) {
    const docId = queue.pop()
    if (docId === undefined) break
    for (const neighbor of outgoing.get(docId) ?? []) {
      if (reached.has(neighbor)) continue
      reached.add(neighbor)
      queue.push(neighbor)
    }
  }
  return [...outgoing.keys()].filter(docId => !reached.has(docId))
}

describe('several threads placing vectors in one graph at once', () => {
  let pool: VectorSearchPool | null = null

  beforeAll(async () => {
    pool = await createVectorSearchPool(WORKER_COUNT)
  }, 60_000)

  afterAll(async () => {
    await pool?.shutdown()
    pool = null
  })

  it('leaves every node reachable from the entry point', async () => {
    expect(pool).not.toBeNull()
    if (pool === null) return
    const activePool = pool
    const orphans: string[] = []

    for (let round = 0; round < ROUNDS; round++) {
      const next = pseudoRandom(20260913 + round)
      const store = createVectorStore({ dimension: DIMENSION, codeBits: null })
      for (let i = 0; i < DOC_COUNT; i++) store.insert(`doc-${round}-${i}`, nextVector(next))
      const graph = createHNSWIndex(DIMENSION, store, { m: 16, efConstruction: 100, metric: 'cosine' })
      const handles: SharedVectorFieldHandles = {
        dimension: DIMENSION,
        quantization: 'none',
        metric: 'cosine',
        store: store.handles,
        graph: graph.handles,
        filterThreshold: 0.03,
        searchable: true,
      }
      const handle = `field#${round}`
      await expect(activePool.loadShared(handle, handles)).resolves.toBe(true)

      const chunks: Int32Array[] = []
      for (let start = 0; start < DOC_COUNT; start += INSERT_CHUNK) {
        const end = Math.min(DOC_COUNT, start + INSERT_CHUNK)
        chunks.push(Int32Array.from({ length: end - start }, (_, i) => start + i))
      }
      const outcomes = await Promise.all(chunks.map(chunk => activePool.insertOrdinals(handle, chunk)))
      expect(outcomes.every(outcome => outcome !== null)).toBe(true)
      expect(graph.size).toBe(DOC_COUNT)

      orphans.push(...unreachableNodes(graph.serialize()))
      await activePool.drop(handle)
      store.release()
    }

    expect(orphans).toEqual([])
  }, 180_000)
})
