import { createHNSWIndex, type HNSWIndex } from '../hnsw'
import { insertIntoGraph } from './build-host'
import {
  adoptGraph,
  allLiveDocIds,
  calibrateAndQuantizeAll,
  liveSize,
  recalibrateFromStore,
  type VectorIndexState,
} from './shared'
import { dropSharedGraph, scheduleWorkerCopyLoad } from './worker-copies'

/**
 * Builds a graph from every live vector in the store and makes it the graph
 * the index answers from once every vector is in.
 *
 * The threads holding the field place the vectors while the old graph, where
 * the index holds one, goes on answering searches, and those threads take the
 * new graph up once it is complete.
 *
 * @param state The index to build for, whose disposal drops the new graph.
 *
 * @internal
 */
export async function buildGraphFromStore(state: VectorIndexState): Promise<void> {
  const graph = createHNSWIndex(state.dimension, state.store, state.hnswConfig, state.sq8 ?? undefined)
  let outsideCalibration = false
  state.freshGraph = graph
  let completed = false
  try {
    completed = await insertIntoGraph(
      state,
      graph,
      allLiveDocIds(state),
      () => true,
      (_docId, outside) => {
        if (outside) outsideCalibration = true
      },
    )
  } finally {
    state.freshGraph = null
  }
  if (!completed) {
    dropSharedGraph(state, graph)
    return
  }
  const previous = state.hnsw
  adoptGraph(state, graph)
  if (previous !== null && previous !== graph) dropSharedGraph(state, previous)
  if (outsideCalibration) recalibrateFromStore(state)
}

async function promoteToGraph(state: VectorIndexState): Promise<void> {
  if (liveSize(state) === 0) return
  if (state.sq8) {
    calibrateAndQuantizeAll(state)
  }
  await buildGraphFromStore(state)
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

  const inserted = (_docId: string, outside: boolean): void => {
    if (outside) outsideCalibration = true
  }

  if (state.sq8 && !state.sq8.isCalibrated()) {
    calibrateAndQuantizeAll(state)
  }

  await insertIntoGraph(state, graph, bufferSnapshot, admit, inserted)

  if (outsideCalibration) {
    recalibrateFromStore(state)
  }
}

export function triggerBuild(state: VectorIndexState): void {
  if (state.building) return
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
      await promoteToGraph(state)
    } finally {
      state.building = false
      state.pendingBuild = null
      if (state.buffer.size > 0) {
        scheduleBuild(state)
      } else {
        scheduleWorkerCopyLoad(state)
      }
    }
  })()

  state.pendingBuild = buildPromise
}

/**
 * Reports whether the buffered vectors are due to go into the graph. The
 * index promotes the field once it holds enough vectors, and afterwards it
 * adds a batch once the buffer reaches that same threshold. Where worker
 * threads hold the field, every batch goes at once, so those threads see each
 * vector without a trip to the main thread.
 *
 * @internal
 */
function buildDue(state: VectorIndexState): boolean {
  if (state.hnsw === null) return liveSize(state) >= state.promotionThreshold
  if (state.buffer.size === 0) return false
  if (state.workerCopies.enabled && state.workerCopies.host !== undefined) return true
  return state.buffer.size >= state.promotionThreshold
}

export function scheduleBuild(state: VectorIndexState): void {
  if (state.building || state.buildScheduled || state.disposed) return
  if (!buildDue(state)) return

  state.buildScheduled = true
  setTimeout(() => {
    state.buildScheduled = false
    triggerBuild(state)
  }, 0)
}
