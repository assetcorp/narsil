import type { HNSWIndex } from '../hnsw'
import { nativeStoreScratchBytes } from '../native/store'
import {
  buildExclusively,
  buildGraphFromStore,
  promoteToGraph,
  shuffledRebuildDue,
  startShuffledRebuild,
} from './build'
import { insertIntoGraph } from './build-host'
import { calibrateBeforeBuild, recalibrateWhenDrifted } from './calibration'
import { ESTIMATED_MS_PER_TOMBSTONE, ESTIMATED_MS_PER_VECTOR_REBUILD } from './constants'
import {
  adoptGraph,
  allLiveDocIds,
  graphNeedsRebuild,
  liveSize,
  type MaintenanceStatus,
  releaseReplacedVectors,
  type VectorIndexState,
} from './shared'
import { dropSharedGraph } from './worker-copies'

export function compact(state: VectorIndexState): void {
  if (state.tombstones.size === 0 && state.store.replacedVectorCount === 0) return

  if (state.hnsw) {
    state.compactedNodeCount += state.hnsw.tombstoneCount
    state.hnsw.compactTombstones()
  }
  state.freshGraph?.compactTombstones()

  for (const docId of state.tombstones) {
    state.store.remove(docId)
    state.buffer.delete(docId)
    if (state.osq) {
      state.osq.remove(docId)
    }
  }

  releaseReplacedVectors(state)
  state.tombstones.clear()
}

async function insertMissing(state: VectorIndexState, graph: HNSWIndex): Promise<void> {
  const missingOrReplaced = (docId: string) => !graph.has(docId) || state.buffer.has(docId)
  const heldWhenTheCallStarted = [...allLiveDocIds(state)]
  const stillLiveAndUnplaced = (docId: string) => !state.tombstones.has(docId) && missingOrReplaced(docId)
  await insertIntoGraph(state, graph, heldWhenTheCallStarted, stillLiveAndUnplaced)
  startShuffledRebuild(state)
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
  if (graph === null || rebuildNeeded || state.shuffledBuildCount === null) {
    if (await calibrateBeforeBuild(state)) await buildGraphFromStore(state)
    return
  }
  if (await recalibrateWhenDrifted(state, liveSize(state))) {
    await buildGraphFromStore(state)
    return
  }
  await insertMissing(state, graph)
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
  if (state.osq && !state.osq.isCalibrated() && !(await calibrateBeforeBuild(state))) return
  if (state.shuffledRebuild === null && graphNeedsRebuild(state)) {
    await buildGraphFromStore(state)
    return
  }
  await insertMissing(state, graph)
}

export function completeGraph(state: VectorIndexState): Promise<void> {
  return buildExclusively(state, () => fillGraph(state), false)
}

export function maintenanceStatus(state: VectorIndexState): MaintenanceStatus {
  const storeSize = state.store.size
  const graphCount = state.hnsw ? 1 : 0
  const graphNodes = state.hnsw === null ? storeSize : state.hnsw.size + state.hnsw.tombstoneCount
  const tombstoned = state.tombstones.size + state.store.replacedVectorCount
  const tombstoneRatio = graphNodes > 0 ? tombstoned / graphNodes : 0
  const estimatedCompactMs = Math.round(tombstoned * ESTIMATED_MS_PER_TOMBSTONE * state.dimensionScale)
  const rebuilds = state.hnsw === null || graphNeedsRebuild(state) || shuffledRebuildDue(state, liveSize(state))
  const optimizeVectorCount = rebuilds ? storeSize : state.buffer.size
  const estimatedOptimizeMs = Math.round(optimizeVectorCount * ESTIMATED_MS_PER_VECTOR_REBUILD * state.dimensionScale)

  return {
    tombstoneRatio,
    graphCount,
    bufferSize: state.buffer.size,
    building: state.building || state.buildScheduled || state.shuffledRebuild !== null,
    estimatedCompactMs,
    estimatedOptimizeMs,
  }
}

function flatScanScratchBytes(state: VectorIndexState): number {
  return state.store.dimension === 0 ? 0 : nativeStoreScratchBytes(state.store.handles)
}

export function estimateMemoryBytes(state: VectorIndexState): number {
  if (state.hnsw === null) return state.store.memoryBytes() + flatScanScratchBytes(state)
  const freshGraphBytes = state.freshGraph?.graphBytes ?? 0
  return state.store.memoryBytes() + state.hnsw.graphBytes + state.hnsw.searchScratchBytes + freshGraphBytes
}
