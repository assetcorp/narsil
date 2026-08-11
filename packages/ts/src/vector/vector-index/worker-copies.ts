import type { VectorMetric } from '../brute-force'
import { acquireVectorSearchPool, releaseVectorSearchPool } from '../search-pool'
import { freezeSharedGeneration } from '../shared-generation/freeze'
import type { WorkerCopySnapshot } from '../worker-copy'
import { liveSize, type VectorIndexState, type VectorScoredResult, WORKER_COPY_MIN_VECTORS } from './shared'

let handleCounter = 0

export function invalidateWorkerCopies(state: VectorIndexState): void {
  state.revision += 1
  if (state.workerCopyHandle === null) return

  const handle = state.workerCopyHandle
  const pool = state.workerCopyPool
  state.workerCopyHandle = null
  state.workerCopyPool = null
  state.workerCopyRevision = -1
  state.workerCopyMode = null

  void pool?.drop(handle).catch(() => undefined)
  void releaseVectorSearchPool().catch(() => undefined)
}

function captureCloneSnapshot(state: VectorIndexState): WorkerCopySnapshot | null {
  if (!state.hnsw) return null
  return {
    dimension: state.dimension,
    quantization: state.quantizationMode,
    calibration: state.sq8?.calibration ?? null,
    store: state.store.exportSnapshot(),
    graph: state.hnsw.exportSnapshot(),
    tombstones: Array.from(state.tombstones),
  }
}

export function scheduleWorkerCopyLoad(state: VectorIndexState): void {
  if (state.disposed || state.workerCopyLoading) return
  if (state.workerCopyHandle !== null) return
  if (!state.hnsw || state.buffer.size > 0) return
  if (liveSize(state) < WORKER_COPY_MIN_VECTORS) return

  state.workerCopyLoading = true
  void loadWorkerCopies(state).finally(() => {
    state.workerCopyLoading = false
  })
}

async function loadWorkerCopies(state: VectorIndexState): Promise<void> {
  const revision = state.revision

  const pool = await acquireVectorSearchPool()
  if (pool === null) {
    await releaseVectorSearchPool()
    return
  }

  if (state.disposed || state.revision !== revision) {
    await releaseVectorSearchPool()
    return
  }

  const shared = freezeSharedGeneration(
    {
      dimension: state.dimension,
      store: state.store,
      hnsw: state.hnsw,
      quantizer: state.sq8,
      quantization: state.quantizationMode,
    },
    pool.scratchSlotCount,
  )

  handleCounter += 1
  const handle = `${state.fieldName}#${handleCounter}`

  let loaded = false
  let mode: 'shared' | 'clone' = 'shared'
  try {
    if (shared !== null) {
      loaded = await pool.loadShared(handle, shared)
    }
    if (!loaded) {
      mode = 'clone'
      const snapshot = captureCloneSnapshot(state)
      if (snapshot !== null) {
        loaded = await pool.load(handle, snapshot)
      }
    }
  } catch {
    loaded = false
  }

  if (!loaded || state.disposed || state.revision !== revision) {
    await pool.drop(handle).catch(() => undefined)
    await releaseVectorSearchPool()
    return
  }

  state.workerCopyPool = pool
  state.workerCopyHandle = handle
  state.workerCopyRevision = revision
  state.workerCopyMode = mode
}

export async function searchViaWorkerCopies(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  efSearch?: number,
): Promise<VectorScoredResult[] | null> {
  const pool = state.workerCopyPool
  const handle = state.workerCopyHandle
  if (pool === null || handle === null) return null
  if (state.workerCopyRevision !== state.revision) return null

  try {
    if (state.workerCopyMode === 'shared') {
      const outcome = await pool.searchOrdinals(handle, query, k, metric, minSimilarity, efSearch)
      const results: VectorScoredResult[] = []
      for (let i = 0; i < outcome.ordinals.length; i++) {
        const docId = state.store.docIdForOrdinal(outcome.ordinals[i])
        if (docId === undefined) continue
        results.push({ docId, score: outcome.scores[i] })
      }
      return results
    }
    return await pool.search(handle, query, k, metric, minSimilarity, efSearch)
  } catch {
    return null
  }
}
