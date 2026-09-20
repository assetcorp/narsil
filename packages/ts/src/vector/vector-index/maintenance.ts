import type { HNSWIndex } from '../hnsw'
import { nativeStoreScratchBytes } from '../native/store'
import { buildGraphFromStore, promoteToGraph, scheduleBuild } from './build'
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
}

function recalibrateWhileNoThreadSearches(state: VectorIndexState, graph: HNSWIndex | null): void {
  if (graph === null) {
    recalibrateFromStore(state)
    return
  }
  graph.exclusively(() => recalibrateFromStore(state))
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
    if (state.osq?.isCalibrated()) recalibrateWhileNoThreadSearches(state, graph)
    await buildGraphFromStore(state)
  } else {
    await insertMissing(state, graph)
  }
}

async function buildExclusively(state: VectorIndexState, work: () => Promise<void>): Promise<void> {
  while (state.pendingBuild) {
    await state.pendingBuild
  }
  if (state.disposed) return

  state.building = true
  const run = work()
  state.pendingBuild = run

  try {
    await run
  } finally {
    state.building = false
    state.pendingBuild = null
    if (state.buffer.size > 0) {
      scheduleBuild(state)
    }
  }
}

export function optimize(state: VectorIndexState): Promise<void> {
  return buildExclusively(state, () => foldIntoGraph(state))
}

async function fillGraph(state: VectorIndexState): Promise<void> {
  const graph = state.hnsw
  if (graph === null) {
    if (liveSize(state) >= state.promotionThreshold) await promoteToGraph(state)
    return
  }
  if (state.osq && !state.osq.isCalibrated()) calibrateQuantizer(state)
  if (graphNeedsRebuild(state)) {
    await buildGraphFromStore(state)
    return
  }
  await insertMissing(state, graph)
}

export function completeGraph(state: VectorIndexState): Promise<void> {
  return buildExclusively(state, () => fillGraph(state))
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

function flatScanScratchBytes(state: VectorIndexState): number {
  return state.store.dimension === 0 ? 0 : nativeStoreScratchBytes(state.store.handles)
}

export function estimateMemoryBytes(state: VectorIndexState): number {
  if (state.hnsw === null) return state.store.memoryBytes() + flatScanScratchBytes(state)
  return state.store.memoryBytes() + state.hnsw.graphBytes + state.hnsw.searchScratchBytes
}
