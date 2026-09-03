import { createHNSWIndex, type HNSWConfig, type HNSWIndex } from '../hnsw'
import { dispatchWorkerBuild } from '../hnsw-worker-dispatch'
import {
  adoptGraph,
  allLiveDocIds,
  calibrateAndQuantizeAll,
  insertIntoGraph,
  liveSize,
  recalibrateFromStore,
  type VectorIndexState,
  WORKER_BUILD_SIZE_THRESHOLD,
} from './shared'
import { invalidateWorkerCopies } from './worker-copies'

function adoptPromotedGraph(state: VectorIndexState, graph: HNSWIndex, bufferSnapshot: Set<string>): void {
  adoptGraph(state, graph)
  for (const docId of bufferSnapshot) {
    state.buffer.delete(docId)
  }
}

async function tryWorkerBuild(
  state: VectorIndexState,
  liveDocIds: string[],
  bufferSnapshot: Set<string>,
): Promise<boolean> {
  const vectorData = new Float32Array(liveDocIds.length * state.dimension)
  const validDocIds: string[] = []
  let offset = 0

  for (const docId of liveDocIds) {
    const entry = state.store.get(docId)
    if (!entry || state.tombstones.has(docId)) continue
    vectorData.set(entry.vector, offset)
    validDocIds.push(docId)
    offset += state.dimension
  }

  if (validDocIds.length === 0) return false

  const packedData = offset < vectorData.length ? vectorData.subarray(0, offset) : vectorData

  const resolvedConfig: HNSWConfig = {
    m: state.hnswConfig?.m,
    efConstruction: state.hnswConfig?.efConstruction,
    metric: state.hnswConfig?.metric,
  }

  const timeoutMs = Math.max(10_000, liveDocIds.length * 2)
  const outcome = await dispatchWorkerBuild(validDocIds, packedData, state.dimension, resolvedConfig, timeoutMs, true)

  if (!outcome.ok) return false

  const newHnsw = createHNSWIndex(state.dimension, state.store, state.hnswConfig, state.sq8 ?? undefined)
  newHnsw.deserialize(outcome.graph)
  adoptPromotedGraph(state, newHnsw, bufferSnapshot)
  return true
}

async function promoteToGraph(state: VectorIndexState, bufferSnapshot: Set<string>): Promise<void> {
  const liveDocIds = Array.from(allLiveDocIds(state))
  if (liveDocIds.length === 0) return

  if (state.sq8) {
    calibrateAndQuantizeAll(state)
  }

  if (liveDocIds.length > WORKER_BUILD_SIZE_THRESHOLD) {
    const built = await tryWorkerBuild(state, liveDocIds, bufferSnapshot)
    if (built) return
  }

  const newHnsw = createHNSWIndex(state.dimension, state.store, state.hnswConfig, state.sq8 ?? undefined)
  const stillLive = (docId: string) => state.store.has(docId) && !state.tombstones.has(docId)
  const completed = await insertIntoGraph(state, newHnsw, liveDocIds, stillLive)
  if (!completed) return

  adoptPromotedGraph(state, newHnsw, bufferSnapshot)
}

/**
 * Quantises one newly stored vector under the calibration the index already
 * holds, and reports whether the vector falls outside those bounds.
 *
 * @internal
 */
function quantizeIncoming(state: VectorIndexState, docId: string): boolean {
  const sq8 = state.sq8
  if (sq8 === null) return false

  if (!sq8.isCalibrated()) {
    calibrateAndQuantizeAll(state)
    return false
  }

  const entry = state.store.get(docId)
  if (entry === undefined) return false

  const outsideBounds = sq8.needsRecalibration(entry.vector)
  sq8.quantize(docId, entry.vector)
  return outsideBounds
}

async function growGraph(state: VectorIndexState, graph: HNSWIndex, bufferSnapshot: Set<string>): Promise<void> {
  let outsideCalibration = false

  const admit = (docId: string): boolean => {
    if (state.hnsw !== graph) return false
    if (state.tombstones.has(docId) || !state.store.has(docId)) {
      state.buffer.delete(docId)
      return false
    }
    return true
  }

  const inserted = (docId: string): void => {
    if (quantizeIncoming(state, docId)) {
      outsideCalibration = true
    }
    state.buffer.delete(docId)
  }

  await insertIntoGraph(state, graph, bufferSnapshot, admit, inserted)

  if (outsideCalibration) {
    recalibrateFromStore(state)
  }
}

export function triggerBuild(state: VectorIndexState): void {
  if (state.building) return
  invalidateWorkerCopies(state)
  state.building = true

  const bufferSnapshot = new Set(state.buffer)
  const existingGraph = state.hnsw

  const buildPromise = (async () => {
    try {
      if (state.disposed) return
      if (existingGraph !== null) {
        await growGraph(state, existingGraph, bufferSnapshot)
        return
      }
      await promoteToGraph(state, bufferSnapshot)
    } finally {
      state.building = false
      state.pendingBuild = null
      if (state.buffer.size > 0) {
        scheduleBuild(state)
      }
    }
  })()

  state.pendingBuild = buildPromise
}

export function scheduleBuild(state: VectorIndexState): void {
  if (state.building || state.buildScheduled || state.disposed) return

  const thresholdMet =
    (!state.hnsw && liveSize(state) >= state.promotionThreshold) ||
    (state.hnsw !== null && state.buffer.size >= state.promotionThreshold)

  if (!thresholdMet) return

  state.buildScheduled = true
  setTimeout(() => {
    state.buildScheduled = false
    triggerBuild(state)
  }, 0)
}
