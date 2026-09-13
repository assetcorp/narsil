import type { HNSWIndex } from '../hnsw'
import { buildGraphFromStore, scheduleBuild } from './build'
import { insertIntoGraph } from './build-host'
import { ESTIMATED_MS_PER_TOMBSTONE, ESTIMATED_MS_PER_VECTOR_REBUILD } from './constants'
import {
  adoptGraph,
  allLiveDocIds,
  calibrateQuantizer,
  graphNeedsRebuild,
  liveSize,
  type MaintenanceStatus,
  recalibrateFromStore,
  type VectorIndexState,
} from './shared'
import { dropSharedGraph } from './worker-copies'

export function compact(state: VectorIndexState): void {
  if (state.tombstones.size === 0) return

  if (state.hnsw) {
    state.compactedNodeCount += state.hnsw.tombstoneCount
    state.hnsw.compactTombstones()
  }

  for (const docId of state.tombstones) {
    state.store.remove(docId)
    state.buffer.delete(docId)
    if (state.osq) {
      state.osq.remove(docId)
    }
  }

  state.tombstones.clear()

  if (state.osq?.isCalibrated() && state.store.size > 0) {
    recalibrateFromStore(state)
  }
}

async function insertMissing(state: VectorIndexState, graph: HNSWIndex): Promise<void> {
  const missingOrReplaced = (docId: string) => !graph.has(docId) || state.buffer.has(docId)
  await insertIntoGraph(state, graph, allLiveDocIds(state), missingOrReplaced)
}

async function foldIntoGraph(state: VectorIndexState): Promise<void> {
  const rebuildNeeded = graphNeedsRebuild(state)

  compact(state)

  if (liveSize(state) === 0) {
    const previous = state.hnsw
    adoptGraph(state, null)
    if (previous !== null) dropSharedGraph(state, previous)
    state.buffer.clear()
    if (state.osq) {
      state.osq.clear()
    }
    return
  }

  const graph = state.hnsw
  if (graph === null || rebuildNeeded) {
    await buildGraphFromStore(state)
  } else {
    await insertMissing(state, graph)
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

async function fillGraph(state: VectorIndexState): Promise<void> {
  const graph = state.hnsw
  if (graph === null) {
    calibrateQuantizer(state)
    await buildGraphFromStore(state)
    return
  }
  if (state.osq && !state.osq.isCalibrated()) calibrateQuantizer(state)
  if (graphNeedsRebuild(state)) {
    await buildGraphFromStore(state)
    return
  }
  await insertMissing(state, graph)
}

/**
 * Places every live vector in the graph and resolves once every one is in.
 * The field builds a graph where it holds none and holds at least the
 * promotion threshold of vectors, builds it afresh where callers have removed
 * enough vectors to warrant that, and places the missing vectors in the graph
 * it holds otherwise. A field holding fewer vectors than the threshold and no
 * graph keeps searching them exactly.
 *
 * @param state The index to complete.
 *
 * @internal
 */
export async function completeGraph(state: VectorIndexState): Promise<void> {
  while (state.pendingBuild) {
    await state.pendingBuild
  }
  if (state.disposed || liveSize(state) === 0) return
  if (state.hnsw === null && liveSize(state) < state.promotionThreshold) return

  state.building = true
  const work = fillGraph(state)
  state.pendingBuild = work

  try {
    await work
  } finally {
    state.building = false
    state.pendingBuild = null
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
  return state.store.memoryBytes() + (state.hnsw === null ? 0 : state.hnsw.graphBytes)
}
