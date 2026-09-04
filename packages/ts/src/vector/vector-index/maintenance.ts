import type { HNSWIndex } from '../hnsw'
import { scheduleBuild } from './build'
import { ESTIMATED_MS_PER_TOMBSTONE, ESTIMATED_MS_PER_VECTOR_REBUILD } from './constants'
import {
  adoptGraph,
  allLiveDocIds,
  buildGraphFromStore,
  graphNeedsRebuild,
  insertIntoGraph,
  liveSize,
  type MaintenanceStatus,
  recalibrateFromStore,
  type VectorIndexState,
} from './shared'

export function compact(state: VectorIndexState): void {
  if (state.tombstones.size === 0) return

  if (state.hnsw) {
    state.compactedNodeCount += state.hnsw.tombstoneCount
    state.hnsw.compactTombstones()
  }

  for (const docId of state.tombstones) {
    state.store.remove(docId)
    state.buffer.delete(docId)
    if (state.sq8) {
      state.sq8.remove(docId)
    }
  }

  state.tombstones.clear()

  if (state.sq8?.isCalibrated() && state.store.size > 0) {
    recalibrateFromStore(state)
  }
}

async function insertMissing(state: VectorIndexState, graph: HNSWIndex): Promise<void> {
  const missingOrReplaced = (docId: string) => !graph.has(docId) || state.buffer.has(docId)
  await insertIntoGraph(state, graph, allLiveDocIds(state), missingOrReplaced)
}

async function foldIntoGraph(state: VectorIndexState): Promise<void> {
  const rebuildNeeded = graphNeedsRebuild(state)
  const compactRecalibrates = state.tombstones.size > 0 && state.sq8?.isCalibrated() === true

  compact(state)

  if (liveSize(state) === 0) {
    adoptGraph(state, null)
    state.buffer.clear()
    if (state.sq8) {
      state.sq8.clear()
    }
    return
  }

  const graph = state.hnsw
  if (graph === null || rebuildNeeded) {
    await buildGraphFromStore(state)
  } else {
    await insertMissing(state, graph)
  }

  if (state.sq8 && state.store.size > 0 && !compactRecalibrates) {
    recalibrateFromStore(state)
  }
}

export async function optimize(state: VectorIndexState): Promise<void> {
  while (state.pendingBuild) {
    await state.pendingBuild
  }
  if (state.disposed) return

  state.building = true
  const work = foldIntoGraph(state)
  state.pendingBuild = work

  try {
    await work
  } finally {
    state.building = false
    state.pendingBuild = null
    if (state.buffer.size > 0) {
      scheduleBuild(state)
    }
  }
}

export function maintenanceStatus(state: VectorIndexState): MaintenanceStatus {
  const storeSize = state.store.size
  const tombstoneRatio = storeSize > 0 ? state.tombstones.size / storeSize : 0
  const graphCount = state.hnsw ? 1 : 0
  const estimatedCompactMs = Math.round(state.tombstones.size * ESTIMATED_MS_PER_TOMBSTONE * state.dimensionScale)
  const optimizeVectorCount = state.hnsw === null || graphNeedsRebuild(state) ? storeSize : state.buffer.size
  const estimatedOptimizeMs = Math.round(optimizeVectorCount * ESTIMATED_MS_PER_VECTOR_REBUILD * state.dimensionScale)

  return {
    tombstoneRatio,
    graphCount,
    bufferSize: state.buffer.size,
    building: state.building || state.buildScheduled,
    estimatedCompactMs,
    estimatedOptimizeMs,
  }
}

export function estimateMemoryBytes(state: VectorIndexState): number {
  const count = state.store.size
  if (count === 0 && state.tombstones.size === 0 && state.buffer.size === 0) return 0

  let bytes = state.store.estimateMemory(state.dimension)

  const TOMBSTONE_SET_OVERHEAD = 64
  const TOMBSTONE_ENTRY_COST = 72
  bytes += TOMBSTONE_SET_OVERHEAD + state.tombstones.size * TOMBSTONE_ENTRY_COST

  const BUFFER_SET_OVERHEAD = 64
  const BUFFER_ENTRY_COST = 72
  bytes += BUFFER_SET_OVERHEAD + state.buffer.size * BUFFER_ENTRY_COST

  if (state.hnsw) {
    bytes += state.hnsw.adjacencyBytes
  }

  if (state.sq8?.isCalibrated()) {
    const sqCount = state.sq8.size
    const MAP_OVERHEAD_SQ = 64
    const MAP_ENTRY_SQ = 72
    const UINT8_ARRAY_HEADER = 64
    const PER_VECTOR_METADATA = 8 * 3
    const GLOBAL_CALIBRATION = 8 * 5

    bytes += 4 * (MAP_OVERHEAD_SQ + sqCount * MAP_ENTRY_SQ)
    bytes += sqCount * (UINT8_ARRAY_HEADER + state.dimension + PER_VECTOR_METADATA)
    bytes += GLOBAL_CALIBRATION
  }

  return Math.round(bytes)
}
