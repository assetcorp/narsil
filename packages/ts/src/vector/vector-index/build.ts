import { createHNSWIndex, type HNSWConfig } from '../hnsw'
import { dispatchWorkerBuild } from '../hnsw-worker-dispatch'
import {
  calibrateAndQuantizeAll,
  liveSize,
  type VectorIndexState,
  WORKER_BUILD_SIZE_THRESHOLD,
  yieldToEventLoop,
} from './shared'

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
  state.hnsw = newHnsw

  for (const docId of state.tombstones) {
    if (newHnsw.has(docId)) {
      newHnsw.markTombstone(docId)
    }
  }

  for (const docId of bufferSnapshot) {
    state.buffer.delete(docId)
  }

  return true
}

export function triggerBuild(state: VectorIndexState): void {
  if (state.building) return
  state.building = true

  const liveDocIds: string[] = []
  for (const [docId] of state.store.entries()) {
    if (state.tombstones.has(docId)) continue
    liveDocIds.push(docId)
  }

  const bufferSnapshot = new Set(state.buffer)

  const buildPromise = (async () => {
    try {
      if (liveDocIds.length === 0 || state.disposed) return

      if (state.sq8) {
        calibrateAndQuantizeAll(state)
      }

      if (liveDocIds.length > WORKER_BUILD_SIZE_THRESHOLD) {
        const workerResult = await tryWorkerBuild(state, liveDocIds, bufferSnapshot)
        if (workerResult) return
      }

      const newHnsw = createHNSWIndex(state.dimension, state.store, state.hnswConfig, state.sq8 ?? undefined)
      const CHUNK_SIZE = 100
      for (let i = 0; i < liveDocIds.length; i++) {
        const docId = liveDocIds[i]
        if (!state.store.has(docId) || state.tombstones.has(docId)) continue
        newHnsw.insertNode(docId)
        if ((i + 1) % CHUNK_SIZE === 0) {
          if (state.disposed) return
          await yieldToEventLoop()
        }
      }

      if (state.disposed) return

      state.hnsw = newHnsw

      for (const docId of state.tombstones) {
        if (newHnsw.has(docId)) {
          newHnsw.markTombstone(docId)
        }
      }

      for (const docId of bufferSnapshot) {
        state.buffer.delete(docId)
      }
    } finally {
      state.building = false
      state.pendingBuild = null
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
