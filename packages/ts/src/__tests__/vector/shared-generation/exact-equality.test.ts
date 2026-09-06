import { describe, expect, it } from 'vitest'
import { createHNSWIndex, type HNSWIndex } from '../../../vector/hnsw'
import { searchOrdinals } from '../../../vector/hnsw/search'
import { createScalarQuantizer } from '../../../vector/scalar-quantization'
import type { ScalarQuantizer } from '../../../vector/scalar-quantization-types'
import { buildSharedDocIdTable, docIdAt, partitionAt } from '../../../vector/shared-generation/doc-ids'
import { freezeSharedGeneration } from '../../../vector/shared-generation/freeze'
import { createSharedVectorSearcher } from '../../../vector/shared-generation/searcher'
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

describe('a request thread searches a shared copy through its document id table', () => {
  const { store, graph, quantizer } = buildField('none')
  const snapshot = freezeSharedGeneration(
    { dimension: DIMENSION, store, hnsw: graph, quantizer, quantization: 'none' },
    SCRATCH_SLOTS,
  )
  const docIds = buildSharedDocIdTable(store, store.slots)

  it('reads every document id and partition back from shared memory', () => {
    for (let ordinal = 0; ordinal < store.slots; ordinal++) {
      expect(docIdAt(docIds, ordinal)).toBe(store.docIdForOrdinal(ordinal))
      expect(partitionAt(docIds, ordinal)).toBe(store.partitionOfOrdinal(ordinal))
    }
    expect(docIdAt(docIds, store.slots + 5)).toBeUndefined()
  })

  it('answers with the document ids and scores the owning thread produces', async () => {
    if (snapshot === null) return
    const searcher = createSharedVectorSearcher({
      fieldName: 'embedding',
      snapshot,
      scratchSlot: 1,
      docIds,
      holdsDocument: () => true,
    })
    const queryNext = pseudoRandom(31)
    for (let q = 0; q < QUERY_COUNT; q++) {
      const query = nextVector(queryNext)
      for (const metric of METRICS) {
        const local = graph.search(query, RESULT_COUNT, metric, -Infinity)
        const hits = await searcher.searchParallel(query, RESULT_COUNT, { metric, minSimilarity: -Infinity })
        expect(hits.map(hit => hit.docId)).toEqual(local.map(result => result.docId))
        for (let position = 0; position < local.length; position++) {
          expect(Object.is(hits[position].score, local[position].score)).toBe(true)
        }
      }
    }
  })

  it('confines a search to the document ids a filter names', async () => {
    if (snapshot === null) return
    const searcher = createSharedVectorSearcher({
      fieldName: 'embedding',
      snapshot,
      scratchSlot: 0,
      docIds,
      holdsDocument: () => true,
    })
    const allowed = new Set(['doc-00010', 'doc-00020', 'doc-00030', 'doc-00040'])
    const hits = await searcher.searchParallel(nextVector(pseudoRandom(8)), RESULT_COUNT, {
      metric: 'cosine',
      minSimilarity: -Infinity,
      filterDocIds: allowed,
    })
    expect(hits.length).toBe(allowed.size)
    for (const hit of hits) expect(allowed.has(hit.docId)).toBe(true)
  })

  it('confines a search to the partitions a filter names', async () => {
    if (snapshot === null) return
    const partitioned = createVectorStore()
    for (let i = 0; i < 64; i++) partitioned.insert(`p-${i}`, nextVector(pseudoRandom(i + 1)), i % 2)
    const partitionedGraph = createHNSWIndex(DIMENSION, partitioned, { m: 8, efConstruction: 50, metric: 'cosine' })
    for (const [docId] of partitioned.entries()) partitionedGraph.insertNode(docId)
    const partitionedSnapshot = freezeSharedGeneration(
      { dimension: DIMENSION, store: partitioned, hnsw: partitionedGraph, quantizer: null, quantization: 'none' },
      1,
    )
    if (partitionedSnapshot === null) return
    const searcher = createSharedVectorSearcher({
      fieldName: 'embedding',
      snapshot: partitionedSnapshot,
      scratchSlot: 0,
      docIds: buildSharedDocIdTable(partitioned, partitioned.slots),
      holdsDocument: () => true,
    })
    expect(searcher.partitionsKnown()).toBe(true)
    const hits = await searcher.searchParallel(nextVector(pseudoRandom(3)), 64, {
      metric: 'cosine',
      minSimilarity: -Infinity,
      filterPartitions: new Set([1]),
    })
    expect(hits.length).toBe(32)
    for (const hit of hits) expect(Number(hit.docId.slice(2)) % 2).toBe(1)
  })

  it('drops a hit whose document the text copy no longer holds', async () => {
    if (snapshot === null) return
    const query = nextVector(pseudoRandom(77))
    const best = graph.search(query, 1, 'cosine', -Infinity)[0].docId
    const searcher = createSharedVectorSearcher({
      fieldName: 'embedding',
      snapshot,
      scratchSlot: 2,
      docIds,
      holdsDocument: docId => docId !== best,
    })
    const hits = await searcher.searchParallel(query, RESULT_COUNT, { metric: 'cosine', minSimilarity: -Infinity })
    expect(hits.map(hit => hit.docId)).not.toContain(best)
  })
})
