import { ErrorCodes, isNarsilError } from '../../errors'
import { createHNSWIndex, type HNSWIndex } from '../hnsw'
import { shuffleInPlace } from '../hnsw/insertion-order'
import { insertIntoGraph } from './build-host'
import { calibrateBeforeBuild, recalibrateWhenDrifted } from './calibration'
import { BUILD_RETRY_FIRST_DELAY_MS, BUILD_RETRY_MAX_DELAY_MS } from './constants'
import { releasePendingLocations } from './disk'
import { adoptGraph, allLiveDocIds, liveSize, type VectorIndexState, yieldBuildTurn } from './shared'
import { dropSharedGraph, invalidateWorkerCopies, noteWrite, scheduleWorkerCopyLoad } from './worker-copies'

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
  if (await calibrateBeforeBuild(state)) await buildGraphFromStore(state)
}

export function shuffledRebuildDue(state: VectorIndexState, held = state.hnsw?.size ?? 0): boolean {
  if (state.hnsw === null || held === 0) return false
  if (state.shuffledBuildCount === null) return true
  return state.osq !== null && held >= state.nextDriftCheckAt
}

async function recalibratesForRebuild(state: VectorIndexState, graph: HNSWIndex): Promise<boolean> {
  if (state.shuffledBuildCount === null) return calibrateBeforeBuild(state)
  return recalibrateWhenDrifted(state, graph.size)
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
  await yieldBuildTurn(state)
  const replacing: { graph: HNSWIndex | null; loadedWithoutCount: boolean } = { graph: null, loadedWithoutCount: false }
  await buildExclusively(
    state,
    async () => {
      const graph = state.hnsw
      if (graph === null || !shuffledRebuildDue(state)) return
      const loadedWithoutCount = state.shuffledBuildCount === null
      if (!(await recalibratesForRebuild(state, graph)) || state.hnsw !== graph) return
      replacing.graph = graph
      replacing.loadedWithoutCount = loadedWithoutCount
    },
    false,
  )
  if (replacing.graph === null || state.hnsw !== replacing.graph) return
  const adopted = await buildGraphFromStore(state)
  if (adopted && replacing.loadedWithoutCount) state.onLoadedGraphRepaired()
}

export function startShuffledRebuild(state: VectorIndexState): void {
  if (state.shuffledRebuild !== null || state.disposed || !shuffledRebuildDue(state)) return
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

  if (state.osq && !state.osq.isCalibrated() && !(await calibrateBeforeBuild(state))) return

  await insertIntoGraph(state, graph, bufferSnapshot, admit)
  startShuffledRebuild(state)
}

export function triggerBuild(state: VectorIndexState): void {
  if (state.building) return
  state.building = true

  const bufferSnapshot = new Set(state.buffer)
  const existingGraph = state.hnsw
  let settled = false
  let timedOut = false

  const buildPromise = (async () => {
    try {
      if (state.disposed) return
      if (existingGraph !== null) {
        await growGraph(state, existingGraph, bufferSnapshot)
        return
      }
      await promoteToGraph(state)
    } catch (error) {
      if (!timedOutOnAnotherThread(state, error)) throw error
      timedOut = true
    } finally {
      settled = true
      state.building = false
      state.pendingBuild = null
      if (timedOut) {
        retryAfterBackoff(state)
      } else {
        state.buildRetryDelayMs = 0
        if (state.buffer.size > 0) scheduleBuild(state)
        else scheduleWorkerCopyLoad(state)
      }
    }
  })()

  if (!settled) state.pendingBuild = buildPromise
}

function timedOutOnAnotherThread(state: VectorIndexState, error: unknown): boolean {
  if (!isNarsilError(error) || error.code !== ErrorCodes.WORKER_TIMEOUT) return false
  console.warn(
    `Building the graph of "${state.indexName}/${state.fieldName}" waited too long for another thread, so it tries again shortly:`,
    error.message,
  )
  return true
}

function armBuildTimer(state: VectorIndexState, delayMs: number, run: () => void): void {
  if (state.disposed || state.buildTimer !== null) return
  const timer = setTimeout(() => {
    state.buildTimer = null
    if (!state.disposed) run()
  }, delayMs)
  timer.unref?.()
  state.buildTimer = timer
}

function retryAfterBackoff(state: VectorIndexState): void {
  const delayMs = Math.min(BUILD_RETRY_MAX_DELAY_MS, Math.max(BUILD_RETRY_FIRST_DELAY_MS, state.buildRetryDelayMs * 2))
  state.buildRetryDelayMs = delayMs
  if (state.buildTimer !== null) clearTimeout(state.buildTimer)
  state.buildTimer = null
  armBuildTimer(state, delayMs, () => {
    const graph = state.hnsw
    if (state.building) {
      retryAfterBackoff(state)
      return
    }
    if (state.buffer.size > 0 || graph === null) {
      triggerBuild(state)
      return
    }
    try {
      graph.connectUnreached()
      noteWrite(state)
      state.buildRetryDelayMs = 0
      scheduleWorkerCopyLoad(state)
    } catch (error) {
      if (timedOutOnAnotherThread(state, error)) retryAfterBackoff(state)
      else console.warn(`Connecting the graph of "${state.indexName}/${state.fieldName}" failed:`, error)
    }
  })
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
  void yieldBuildTurn(state).then(() => {
    state.buildScheduled = false
    triggerBuild(state)
  })
}

export async function awaitBuilds(state: VectorIndexState): Promise<void> {
  for (;;) {
    const running = state.pendingBuild ?? state.shuffledRebuild
    if (running === null) return
    await running
  }
}

function releaseHeldMemory(state: VectorIndexState): void {
  state.hnsw = null
  state.freshGraph = null
  state.osq = null
  state.tombstones.clear()
  state.buffer.clear()
  state.pendingLocations.clear()
  state.savedFiles = []
  state.savedSignature = null
  state.store.release()
}

export function disposeIndex(state: VectorIndexState): void {
  state.disposed = true
  if (state.buildTimer !== null) clearTimeout(state.buildTimer)
  state.buildTimer = null
  invalidateWorkerCopies(state)
  const release = (): void => releaseHeldMemory(state)
  if (state.pendingBuild !== null || state.shuffledRebuild !== null) {
    void awaitBuilds(state).then(release, release)
    return
  }
  release()
}
