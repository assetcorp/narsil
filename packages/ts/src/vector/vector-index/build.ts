import { createHNSWIndex, type HNSWIndex } from '../hnsw'
import { shuffleInPlace } from '../hnsw/insertion-order'
import { insertIntoGraph } from './build-host'
import { REBUILD_GROWTH_FACTOR } from './constants'
import { releasePendingLocations } from './disk'
import {
  adoptGraph,
  allLiveDocIds,
  calibrateQuantizer,
  liveSize,
  recalibrateFromStore,
  type VectorIndexState,
  yieldToEventLoop,
} from './shared'
import { dropSharedGraph, noteWrite, scheduleWorkerCopyLoad } from './worker-copies'

function bufferWhatTheGraphLacks(state: VectorIndexState, graph: HNSWIndex): void {
  for (const docId of allLiveDocIds(state)) {
    const ordinal = state.store.getOrdinal(docId)
    if (ordinal !== undefined && graph.holdsNode(ordinal) && !graph.holdsTombstone(ordinal)) state.buffer.delete(docId)
    else state.buffer.add(docId)
  }
}

export async function buildGraphFromStore(state: VectorIndexState): Promise<boolean> {
  const previous = state.hnsw
  const graph = createHNSWIndex(state.dimension, state.store, state.hnswConfig, state.osq ?? undefined)
  state.freshGraph = graph
  let completed = false
  try {
    completed = await insertIntoGraph(state, graph, shuffleInPlace([...allLiveDocIds(state)]), () => true)
  } finally {
    state.freshGraph = null
  }
  if (!completed || state.hnsw !== previous) {
    dropSharedGraph(state, graph)
    return false
  }
  adoptGraph(state, graph)
  state.shuffledBuildCount = graph.size
  noteWrite(state)
  bufferWhatTheGraphLacks(state, graph)
  if (previous !== null) dropSharedGraph(state, previous)
  await releasePendingLocations(state)
  return true
}

export async function promoteToGraph(state: VectorIndexState): Promise<void> {
  if (liveSize(state) === 0) return
  calibrateQuantizer(state)
  await buildGraphFromStore(state)
}

export function calibrateBeforeRebuild(state: VectorIndexState, graph: HNSWIndex | null): void {
  if (!state.osq?.isCalibrated()) {
    calibrateQuantizer(state)
    return
  }
  if (graph === null) {
    recalibrateFromStore(state)
    return
  }
  graph.exclusively(() => recalibrateFromStore(state))
}

export function shuffledBuildDue(state: VectorIndexState, held = state.hnsw?.size ?? 0): boolean {
  if (state.hnsw === null || held === 0) return false
  if (state.shuffledBuildCount === null) return true
  return held >= REBUILD_GROWTH_FACTOR * state.shuffledBuildCount
}

export async function buildExclusively(
  state: VectorIndexState,
  work: () => Promise<void>,
  waitsForShuffledRebuild = true,
): Promise<void> {
  for (;;) {
    if (state.pendingBuild !== null) await state.pendingBuild
    else if (waitsForShuffledRebuild && state.shuffledRebuild !== null) await state.shuffledRebuild
    else break
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

async function rebuildInShuffledOrder(state: VectorIndexState): Promise<void> {
  await yieldToEventLoop()
  const replacing: { graph: HNSWIndex | null; loadedWithoutCount: boolean } = { graph: null, loadedWithoutCount: false }
  await buildExclusively(
    state,
    async () => {
      if (!shuffledBuildDue(state)) return
      replacing.graph = state.hnsw
      replacing.loadedWithoutCount = state.shuffledBuildCount === null
      calibrateBeforeRebuild(state, replacing.graph)
    },
    false,
  )
  if (replacing.graph === null || state.hnsw !== replacing.graph) return
  const adopted = await buildGraphFromStore(state)
  if (adopted && replacing.loadedWithoutCount) state.onLoadedGraphRepaired()
}

export function startShuffledRebuild(state: VectorIndexState): void {
  if (state.shuffledRebuild !== null || state.disposed || !shuffledBuildDue(state)) return
  state.shuffledRebuild = rebuildInShuffledOrder(state)
    .catch((error: unknown) => {
      console.warn(
        `Rebuilding the graph of "${state.indexName}/${state.fieldName}" in a shuffled order failed, so the field keeps the graph it holds:`,
        error,
      )
    })
    .finally(() => {
      state.shuffledRebuild = null
      scheduleBuild(state)
      scheduleWorkerCopyLoad(state)
    })
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
  startShuffledRebuild(state)
}

export function triggerBuild(state: VectorIndexState): void {
  if (state.building) return
  state.building = true

  const bufferSnapshot = new Set(state.buffer)
  const existingGraph = state.hnsw
  let settled = false

  const buildPromise = (async () => {
    try {
      if (state.disposed) return
      if (existingGraph !== null) {
        await growGraph(state, existingGraph, bufferSnapshot)
        return
      }
      await promoteToGraph(state)
    } finally {
      settled = true
      state.building = false
      state.pendingBuild = null
      if (state.buffer.size > 0) {
        scheduleBuild(state)
      } else {
        scheduleWorkerCopyLoad(state)
      }
    }
  })()

  if (!settled) state.pendingBuild = buildPromise
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

export async function awaitBuilds(state: VectorIndexState): Promise<void> {
  for (;;) {
    const running = state.pendingBuild ?? state.shuffledRebuild
    if (running === null) return
    await running
  }
}
