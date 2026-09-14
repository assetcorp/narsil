import { createHNSWIndex, type HNSWIndex } from '../hnsw'
import { insertIntoGraph } from './build-host'
import { releasePendingLocations } from './disk'
import { adoptGraph, allLiveDocIds, calibrateQuantizer, liveSize, type VectorIndexState } from './shared'
import { dropSharedGraph, scheduleWorkerCopyLoad } from './worker-copies'

export async function buildGraphFromStore(state: VectorIndexState): Promise<void> {
  const graph = createHNSWIndex(state.dimension, state.store, state.hnswConfig, state.osq ?? undefined)
  state.freshGraph = graph
  let completed = false
  try {
    completed = await insertIntoGraph(state, graph, allLiveDocIds(state), () => true)
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
  await releasePendingLocations(state)
}

export async function promoteToGraph(state: VectorIndexState): Promise<void> {
  if (liveSize(state) === 0) return
  calibrateQuantizer(state)
  await buildGraphFromStore(state)
}

async function growGraph(state: VectorIndexState, graph: HNSWIndex, bufferSnapshot: Set<string>): Promise<void> {
  const admit = (docId: string): boolean => {
    if (state.hnsw !== graph) return false
    if (state.tombstones.has(docId) || !state.store.has(docId)) {
      state.buffer.delete(docId)
      return false
    }
    return true
  }

  if (state.osq && !state.osq.isCalibrated()) calibrateQuantizer(state)

  await insertIntoGraph(state, graph, bufferSnapshot, admit)
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
