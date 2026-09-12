import type { VectorMetric } from '../brute-force'
import type { HNSWIndex } from '../hnsw'
import type { OrdinalFilter } from '../ordinal-filter'
import { acquireVectorSearchPool, releaseVectorSearchPool } from '../search-pool'
import { sharedMemoryAvailable } from '../shared-buffers/growable'
import type { WorkerCopySnapshot } from '../worker-copy'
import { WORKER_COPY_MIN_VECTORS } from './constants'
import {
  assignStorePartitions,
  fieldHandlesOf,
  liveSize,
  type SharedCopyHost,
  type VectorIndexState,
  type VectorScoredResult,
  type WorkerCopyMode,
} from './shared'

let handleCounter = 0

function nextHandle(state: VectorIndexState): string {
  handleCounter += 1
  return `${state.indexName}/${state.fieldName}#${handleCounter}`
}

/**
 * Reports the handle the threads know a graph by, or null where they hold
 * none.
 *
 * @param state The index the graph belongs to.
 * @param graph The graph to ask about, or null for the vectors alone.
 * @returns The handle, or null where no thread holds it.
 *
 * @internal
 */
export function sharedHandleOf(state: VectorIndexState, graph: HNSWIndex | null): string | null {
  return state.sharedHandles.get(graph)?.handle ?? null
}

async function dropHandle(state: VectorIndexState, handle: string): Promise<void> {
  const host = state.workerCopies.host
  if (host !== undefined) {
    await host.drop(state.indexName, state.fieldName, handle).catch(() => undefined)
    return
  }
  const pool = state.workerCopyPool
  if (pool !== null) {
    await pool.drop(handle).catch(() => undefined)
    await releaseVectorSearchPool().catch(() => undefined)
  }
}

/**
 * Withdraws a graph from every thread that holds it.
 *
 * @param state The index the graph belongs to.
 * @param graph The graph to withdraw, or null for the vectors alone.
 *
 * @internal
 */
export function dropSharedGraph(state: VectorIndexState, graph: HNSWIndex | null): void {
  const shared = state.sharedHandles.get(graph)
  if (shared === undefined) return
  state.sharedHandles.delete(graph)
  if (state.workerCopyHandle === shared.handle) {
    state.workerCopyHandle = null
    state.workerCopyRevision = -1
    state.workerCopyMode = null
  }
  void dropHandle(state, shared.handle)
}

/**
 * Withdraws every copy the threads hold, which a cloned copy needs after any
 * write, and which a shared field needs once the threads holding it are gone.
 *
 * @param state The index whose copies to withdraw.
 *
 * @internal
 */
export function invalidateWorkerCopies(state: VectorIndexState): void {
  state.revision += 1
  for (const graph of [...state.sharedHandles.keys()]) dropSharedGraph(state, graph)
  if (state.workerCopyHandle !== null) {
    const handle = state.workerCopyHandle
    state.workerCopyHandle = null
    state.workerCopyRevision = -1
    state.workerCopyMode = null
    void dropHandle(state, handle)
  }
  if (state.workerCopies.host === undefined && state.workerCopyPool !== null && state.sharedHandles.size === 0) {
    state.workerCopyPool = null
  }
}

/**
 * Notes a write to the field, withdrawing a cloned copy, while a shared field
 * goes on serving because the threads read the write in place.
 *
 * @param state The index the write reached.
 *
 * @internal
 */
export function noteWrite(state: VectorIndexState): void {
  state.revision += 1
  if (state.workerCopyMode === 'clone') invalidateWorkerCopies(state)
}

export function refreshWorkerCopies(state: VectorIndexState): void {
  invalidateWorkerCopies(state)
  scheduleWorkerCopyLoad(state)
}

interface SharedFieldRecord {
  graph: HNSWIndex | null
  handle: string
  searchable: boolean
  mode: WorkerCopyMode
  revision: number
  blockCount: number
}

function recordSharedField(state: VectorIndexState, record: SharedFieldRecord): void {
  const { graph, handle, searchable, mode, revision, blockCount } = record
  state.sharedHandles.set(graph, { handle, searchable, mode })
  state.sharedBlockCount = blockCount
  if (!searchable) return
  state.workerCopyHandle = handle
  state.workerCopyRevision = revision
  state.workerCopyMode = mode
}

async function loadOnHost(
  state: VectorIndexState,
  host: SharedCopyHost,
  graph: HNSWIndex | null,
  searchable: boolean,
): Promise<string | null> {
  if (!host.holdsIndex(state.indexName)) return null
  if (!state.store.partitionsKnown) {
    assignStorePartitions(state, docId => host.resolvePartition(state.indexName, docId))
  }
  const handle = state.sharedHandles.get(graph)?.handle ?? nextHandle(state)
  const blockCount = state.store.handles.blocks.length
  let loaded = false
  try {
    loaded = await host.loadShared(state.indexName, state.fieldName, handle, fieldHandlesOf(state, graph, searchable))
  } catch {
    loaded = false
  }
  if (!loaded || state.disposed) return null
  recordSharedField(state, { graph, handle, searchable, mode: 'hosted', revision: state.revision, blockCount })
  return handle
}

function captureCloneSnapshot(state: VectorIndexState, graph: HNSWIndex): WorkerCopySnapshot {
  return {
    dimension: state.dimension,
    quantization: state.quantizationMode,
    calibration: state.sq8?.calibration ?? null,
    store: state.store.exportSnapshot(),
    graph: graph.exportSnapshot(),
    tombstones: Array.from(state.tombstones),
  }
}

async function loadOnPool(
  state: VectorIndexState,
  graph: HNSWIndex | null,
  searchable: boolean,
): Promise<string | null> {
  if (graph === null) return null
  const revision = state.revision
  const pool = state.workerCopyPool ?? (await acquireVectorSearchPool(state.workerCopies.count))
  if (pool === null) {
    await releaseVectorSearchPool()
    return null
  }
  if (state.disposed) {
    await releaseVectorSearchPool()
    return null
  }
  state.workerCopyPool = pool

  const handle = state.sharedHandles.get(graph)?.handle ?? nextHandle(state)
  const blockCount = state.store.handles.blocks.length
  let mode: 'shared' | 'clone' = 'shared'
  let loaded = false
  try {
    if (sharedMemoryAvailable()) {
      loaded = await pool.loadShared(handle, fieldHandlesOf(state, graph, searchable))
    }
    if (!loaded && searchable) {
      mode = 'clone'
      loaded = await pool.load(handle, captureCloneSnapshot(state, graph))
    }
  } catch {
    loaded = false
  }
  if (!loaded || state.disposed || (mode === 'clone' && state.revision !== revision)) {
    await pool.drop(handle).catch(() => undefined)
    return null
  }
  recordSharedField(state, { graph, handle, searchable, mode, revision, blockCount })
  return handle
}

/**
 * Sends a graph to the threads holding the field, and sends it again where
 * the store gained a block or the graph became searchable, reporting the
 * handle those threads know it by.
 *
 * @param state The index the graph belongs to.
 * @param graph The graph to share.
 * @param searchable Whether the threads answer searches from it.
 * @returns The handle, or null where no thread could take it.
 *
 * @internal
 */
export function shareGraph(
  state: VectorIndexState,
  graph: HNSWIndex | null,
  searchable: boolean,
): Promise<string | null> {
  const run = state.sharing.then(async () => {
    if (!state.workerCopies.enabled || state.disposed) return null
    const existing = state.sharedHandles.get(graph)
    const blocksUnchanged = state.sharedBlockCount === state.store.handles.blocks.length
    if (existing !== undefined && blocksUnchanged && (existing.searchable || !searchable)) return existing.handle
    const host = state.workerCopies.host
    return host !== undefined ? loadOnHost(state, host, graph, searchable) : loadOnPool(state, graph, searchable)
  })
  state.sharing = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Sends the graph the index answers from to the threads holding the field,
 * once the index holds a graph and no build is in flight.
 *
 * @param state The index to share.
 *
 * @internal
 */
export function scheduleWorkerCopyLoad(state: VectorIndexState): void {
  if (!state.workerCopies.enabled) return
  if (state.disposed || state.workerCopyLoading || state.building) return
  const graph = state.hnsw
  const host = state.workerCopies.host
  if (graph === null && host === undefined) return
  const existing = state.sharedHandles.get(graph)
  if (existing?.searchable && state.sharedBlockCount === state.store.handles.blocks.length) return
  if (host === undefined && liveSize(state) < WORKER_COPY_MIN_VECTORS) return

  state.workerCopyLoading = true
  void shareGraph(state, graph, true).then(
    () => {
      state.workerCopyLoading = false
    },
    () => {
      state.workerCopyLoading = false
    },
  )
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
  if (state.workerCopyMode === 'clone' && state.workerCopyRevision !== state.revision) return null

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
