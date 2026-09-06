import type { VectorMetric } from '../brute-force'
import type { OrdinalFilter } from '../ordinal-filter'
import { acquireVectorSearchPool, releaseVectorSearchPool } from '../search-pool'
import { buildSharedDocIdTable } from '../shared-generation/doc-ids'
import { freezeSharedGeneration } from '../shared-generation/freeze'
import type { WorkerCopySnapshot } from '../worker-copy'
import { WORKER_COPY_MIN_VECTORS } from './constants'
import {
  assignStorePartitions,
  liveSize,
  type SharedCopyHost,
  type VectorIndexState,
  type VectorScoredResult,
} from './shared'

let handleCounter = 0

export function invalidateWorkerCopies(state: VectorIndexState): void {
  state.revision += 1
  if (state.workerCopyHandle === null) return

  const handle = state.workerCopyHandle
  const pool = state.workerCopyPool
  const hosted = state.workerCopyMode === 'hosted'
  state.workerCopyHandle = null
  state.workerCopyPool = null
  state.workerCopyRevision = -1
  state.workerCopyMode = null

  if (hosted) {
    void state.workerCopies.host?.drop(state.indexName, state.fieldName, handle).catch(() => undefined)
    return
  }
  void pool?.drop(handle).catch(() => undefined)
  void releaseVectorSearchPool().catch(() => undefined)
}

export function refreshWorkerCopies(state: VectorIndexState): void {
  invalidateWorkerCopies(state)
  scheduleWorkerCopyLoad(state)
}

async function loadHostedCopy(state: VectorIndexState, host: SharedCopyHost): Promise<boolean> {
  const revision = state.revision
  if (!host.holdsIndex(state.indexName)) return false
  if (!state.store.partitionsKnown) {
    assignStorePartitions(state, docId => host.resolvePartition(state.indexName, docId))
  }
  const shared = freezeSharedGeneration(
    {
      dimension: state.dimension,
      store: state.store,
      hnsw: state.hnsw,
      quantizer: state.sq8,
      quantization: state.quantizationMode,
    },
    host.scratchSlotCount,
  )
  if (shared === null) return false
  const docIds = buildSharedDocIdTable(state.store, state.store.slots)

  handleCounter += 1
  const handle = `${state.indexName}/${state.fieldName}#${handleCounter}`
  state.workerCopyHandle = handle
  state.workerCopyRevision = revision
  state.workerCopyMode = 'hosted'

  let loaded = false
  try {
    loaded = await host.loadShared(state.indexName, state.fieldName, handle, {
      snapshot: shared,
      docIds,
      filterThreshold: state.filterThreshold,
    })
  } catch {
    loaded = false
  }
  if (!loaded && state.workerCopyHandle === handle) {
    state.workerCopyHandle = null
    state.workerCopyRevision = -1
    state.workerCopyMode = null
  }
  return !state.disposed && state.revision !== revision
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
  if (!state.workerCopies.enabled) return
  if (state.disposed || state.workerCopyLoading || state.building) return
  if (state.workerCopyHandle !== null) return
  if (!state.hnsw || state.buffer.size > 0) return
  const host = state.workerCopies.host
  if (host === undefined && liveSize(state) < WORKER_COPY_MIN_VECTORS) return

  state.workerCopyLoading = true
  const loading = host === undefined ? loadWorkerCopies(state).then(() => false) : loadHostedCopy(state, host)
  void loading.then(
    superseded => {
      state.workerCopyLoading = false
      if (superseded) scheduleWorkerCopyLoad(state)
    },
    () => {
      state.workerCopyLoading = false
    },
  )
}

async function loadWorkerCopies(state: VectorIndexState): Promise<void> {
  const revision = state.revision

  const pool = await acquireVectorSearchPool(state.workerCopies.count)
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
  filter?: OrdinalFilter,
): Promise<VectorScoredResult[] | null> {
  const pool = state.workerCopyPool
  const handle = state.workerCopyHandle
  if (pool === null || handle === null || state.workerCopyMode === 'hosted') return null
  if (state.workerCopyRevision !== state.revision) return null

  try {
    if (state.workerCopyMode === 'shared') {
      const outcome = await pool.searchOrdinals(handle, query, k, metric, minSimilarity, efSearch, filter)
      const results: VectorScoredResult[] = []
      for (let i = 0; i < outcome.ordinals.length; i++) {
        const docId = state.store.docIdForOrdinal(outcome.ordinals[i])
        if (docId === undefined) continue
        results.push({ docId, score: outcome.scores[i] })
      }
      return results
    }
    return await pool.search(handle, query, k, metric, minSimilarity, efSearch, filter)
  } catch {
    return null
  }
}
