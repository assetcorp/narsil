import { describe, expect, it } from 'vitest'
import { createHNSWIndex } from '../../vector/hnsw'
import { createScalarQuantizer } from '../../vector/scalar-quantization'
import type { ScalarQuantizerCalibration } from '../../vector/scalar-quantization-types'
import { createVectorStore } from '../../vector/vector-store'
import { restoreWorkerCopy, type WorkerCopySnapshot } from '../../vector/worker-copy'

const DIMENSION = 32
const ORDINARY_COUNT = 1500
const BOUNDARY_DOC_ID = 'doc-boundary'
const SEARCH_DEPTH = 16
const RESULT_COUNT = 10
const QUERY_COUNT = 50

function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function ordinaryVector(next: () => number): Float32Array {
  const vector = new Float32Array(DIMENSION)
  for (let component = 0; component < DIMENSION; component++) {
    vector[component] = next() - 0.5
  }
  return vector
}

function boundaryVector(): Float32Array {
  return new Float32Array(DIMENSION).fill(60)
}

function buildIndexHoldingBoundaryVector() {
  const next = pseudoRandom(20260807)
  const store = createVectorStore()
  for (let seed = 0; seed < ORDINARY_COUNT; seed++) {
    store.insert(`doc-${seed}`, ordinaryVector(next))
  }
  store.insert(BOUNDARY_DOC_ID, boundaryVector())

  const quantizer = createScalarQuantizer(DIMENSION, store)
  const live: Float32Array[] = []
  for (const [, entry] of store.entries()) live.push(entry.vector)
  quantizer.calibrate(live)
  for (const [docId, entry] of store.entries()) quantizer.quantize(docId, entry.vector)

  const graph = createHNSWIndex(DIMENSION, store, undefined, quantizer)
  for (const [docId] of store.entries()) graph.insertNode(docId)

  function snapshotWith(calibration: ScalarQuantizerCalibration | null): WorkerCopySnapshot {
    return {
      dimension: DIMENSION,
      quantization: 'sq8',
      calibration,
      store: store.exportSnapshot(),
      graph: graph.exportSnapshot(),
      tombstones: [BOUNDARY_DOC_ID],
    }
  }

  return { store, graph, quantizer, next, snapshotWith }
}

function countDivergentQueries(
  graph: ReturnType<typeof createHNSWIndex>,
  copyGraph: ReturnType<typeof createHNSWIndex>,
  next: () => number,
): number {
  let divergent = 0
  for (let attempt = 0; attempt < QUERY_COUNT; attempt++) {
    const query = ordinaryVector(next)
    const onCallingThread = graph.search(query, RESULT_COUNT, 'cosine', 0, undefined, SEARCH_DEPTH)
    const onWorker = copyGraph.search(query, RESULT_COUNT, 'cosine', 0, undefined, SEARCH_DEPTH)

    const callingIds = onCallingThread.map(hit => hit.docId).join(',')
    const workerIds = onWorker.map(hit => hit.docId).join(',')
    if (callingIds !== workerIds) divergent++
  }
  return divergent
}

describe('a worker copy taken after a boundary document is deleted', () => {
  it('returns the same documents as the calling thread for every query', () => {
    const { graph, quantizer, next, snapshotWith } = buildIndexHoldingBoundaryVector()
    const snapshot = snapshotWith(quantizer.calibration)

    graph.markTombstone(BOUNDARY_DOC_ID)
    const copy = restoreWorkerCopy(snapshot)

    expect(countDivergentQueries(graph, copy.graph, next)).toBe(0)
  })

  it('diverges from the calling thread when it derives its own constants instead', () => {
    const { graph, next, snapshotWith } = buildIndexHoldingBoundaryVector()
    const snapshot = snapshotWith(null)

    graph.markTombstone(BOUNDARY_DOC_ID)
    const copy = restoreWorkerCopy(snapshot)

    expect(countDivergentQueries(graph, copy.graph, next)).toBeGreaterThan(0)
  })

  it('carries the calling thread constants on the snapshot', () => {
    const { quantizer } = buildIndexHoldingBoundaryVector()

    expect(quantizer.calibration).not.toBeNull()
    expect(quantizer.calibration?.alpha).toBeGreaterThan(0)
  })

  it('leaves the deleted document out of its results', () => {
    const { quantizer, snapshotWith } = buildIndexHoldingBoundaryVector()
    const copy = restoreWorkerCopy(snapshotWith(quantizer.calibration))

    const hits = copy.graph.search(boundaryVector(), RESULT_COUNT, 'cosine', 0)

    expect(hits.map(hit => hit.docId)).not.toContain(BOUNDARY_DOC_ID)
  })
})
