import { describe, expect, it } from 'vitest'
import { createHNSWIndex, type HNSWIndex } from '../../../vector/hnsw'
import { searchOrdinals } from '../../../vector/hnsw/search'
import { createScalarQuantizer } from '../../../vector/scalar-quantization'
import type { ScalarQuantizer } from '../../../vector/scalar-quantization-types'
import { freezeSharedGeneration } from '../../../vector/shared-generation/freeze'
import { openSharedWorkerCopy } from '../../../vector/shared-generation/worker-view'
import { createVectorStore, type VectorStore } from '../../../vector/vector-store'

const DIMENSION = 96
const DOC_COUNT = 2000
const TOMBSTONE_STRIDE = 7
const QUERY_COUNT = 25
const RESULT_COUNT = 10
const SCRATCH_SLOTS = 4
const METRICS = ['cosine', 'dotProduct', 'euclidean'] as const

function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function nextVector(next: () => number): Float32Array {
  const vector = new Float32Array(DIMENSION)
  for (let component = 0; component < DIMENSION; component++) {
    vector[component] = next() - 0.5
  }
  return vector
}

function buildField(quantization: 'sq8' | 'none'): {
  store: VectorStore
  graph: HNSWIndex
  quantizer: ScalarQuantizer | null
} {
  const next = pseudoRandom(20260810)
  const store = createVectorStore()
  for (let i = 0; i < DOC_COUNT; i++) {
    store.insert(`doc-${String(i).padStart(5, '0')}`, nextVector(next))
  }

  let quantizer: ScalarQuantizer | null = null
  if (quantization === 'sq8') {
    quantizer = createScalarQuantizer(DIMENSION, store)
    const all: Float32Array[] = []
    for (const [, entry] of store.entries()) all.push(entry.vector)
    quantizer.calibrate(all)
    for (const [docId, entry] of store.entries()) quantizer.quantize(docId, entry.vector)
  }

  const graph = createHNSWIndex(
    DIMENSION,
    store,
    { m: 16, efConstruction: 100, metric: 'cosine' },
    quantizer ?? undefined,
  )
  for (const [docId] of store.entries()) graph.insertNode(docId)
  for (let i = 0; i < DOC_COUNT; i += TOMBSTONE_STRIDE) {
    graph.markTombstone(`doc-${String(i).padStart(5, '0')}`)
  }

  return { store, graph, quantizer }
}

describe.each(['sq8', 'none'] as const)('a shared copy under %s quantisation', quantization => {
  const { store, graph, quantizer } = buildField(quantization)
  const snapshot = freezeSharedGeneration(
    { dimension: DIMENSION, store, hnsw: graph, quantizer, quantization },
    SCRATCH_SLOTS,
  )

  it('freezes', () => {
    expect(snapshot).not.toBeNull()
  })

  it('answers every query exactly as the owning thread does, from every scratch slot', () => {
    if (snapshot === null) return
    const queryNext = pseudoRandom(97)

    for (let slot = 0; slot < SCRATCH_SLOTS; slot++) {
      const copy = openSharedWorkerCopy(snapshot, slot)

      for (let q = 0; q < QUERY_COUNT; q++) {
        const query = nextVector(queryNext)
        for (const metric of METRICS) {
          const local = graph.search(query, RESULT_COUNT, metric, -Infinity)
          const hits = searchOrdinals(copy.searchState, query, RESULT_COUNT, metric, -Infinity, copy.rankByOrdinal)
          const mapped = hits.map(hit => ({ docId: store.docIdForOrdinal(hit.ord), score: hit.score }))

          expect(mapped.map(entry => entry.docId)).toEqual(local.map(result => result.docId))
          for (let position = 0; position < local.length; position++) {
            expect(Object.is(mapped[position].score, local[position].score)).toBe(true)
          }
        }
      }
    }
  })

  it('never returns a tombstoned or deleted document', () => {
    if (snapshot === null) return
    const copy = openSharedWorkerCopy(snapshot, 0)
    const query = nextVector(pseudoRandom(555))
    const hits = searchOrdinals(copy.searchState, query, DOC_COUNT, 'cosine', -Infinity, copy.rankByOrdinal)
    for (const hit of hits) {
      const docId = store.docIdForOrdinal(hit.ord)
      expect(docId).toBeDefined()
      expect(graph.isTombstoned(docId ?? '')).toBe(false)
    }
  })
})
