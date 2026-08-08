import type { VectorMetric } from '../brute-force'
import type { VectorReplicaSnapshot } from '../replica'
import { acquireVectorSearchPool, releaseVectorSearchPool } from '../search-pool'
import { liveSize, REPLICA_MIN_VECTORS, type VectorIndexState, type VectorScoredResult } from './shared'

let handleCounter = 0

export function invalidateReplicas(state: VectorIndexState): void {
  state.revision += 1
  if (state.replicaHandle === null) return

  const handle = state.replicaHandle
  const pool = state.replicaPool
  state.replicaHandle = null
  state.replicaPool = null
  state.replicaRevision = -1

  void pool?.drop(handle).catch(() => undefined)
  void releaseVectorSearchPool().catch(() => undefined)
}

function captureSnapshot(state: VectorIndexState): VectorReplicaSnapshot | null {
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

export function scheduleReplicaLoad(state: VectorIndexState): void {
  if (state.disposed || state.replicaLoading) return
  if (state.replicaHandle !== null) return
  if (!state.hnsw || state.buffer.size > 0) return
  if (liveSize(state) < REPLICA_MIN_VECTORS) return

  state.replicaLoading = true
  void loadReplicas(state).finally(() => {
    state.replicaLoading = false
  })
}

async function loadReplicas(state: VectorIndexState): Promise<void> {
  const revision = state.revision
  const snapshot = captureSnapshot(state)
  if (snapshot === null) return

  const pool = await acquireVectorSearchPool()
  if (pool === null) {
    await releaseVectorSearchPool()
    return
  }

  if (state.disposed || state.revision !== revision) {
    await releaseVectorSearchPool()
    return
  }

  handleCounter += 1
  const handle = `${state.fieldName}#${handleCounter}`

  let loaded = false
  try {
    loaded = await pool.load(handle, snapshot)
  } catch {
    loaded = false
  }

  if (!loaded || state.disposed || state.revision !== revision) {
    await pool.drop(handle).catch(() => undefined)
    await releaseVectorSearchPool()
    return
  }

  state.replicaPool = pool
  state.replicaHandle = handle
  state.replicaRevision = revision
}

export async function searchViaReplicas(
  state: VectorIndexState,
  query: Float32Array,
  k: number,
  metric: VectorMetric,
  minSimilarity: number,
  efSearch?: number,
): Promise<VectorScoredResult[] | null> {
  const pool = state.replicaPool
  const handle = state.replicaHandle
  if (pool === null || handle === null) return null
  if (state.replicaRevision !== state.revision) return null

  try {
    return await pool.search(handle, query, k, metric, minSimilarity, efSearch)
  } catch {
    return null
  }
}
