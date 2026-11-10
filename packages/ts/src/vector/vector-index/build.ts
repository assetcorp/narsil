import {
  adoptGraph,
  allLiveDocIds,
  BUILD_RETRY_FIRST_DELAY_MS,
  BUILD_RETRY_MAX_DELAY_MS,
  createHNSWIndex,
  ErrorCodes,
  isNarsilError,
  liveSize,
  SHUFFLED_REBUILD_MEMORY_RETRY_MS,
  shuffleInPlace,
  turnsAreBudgeted,
  yieldBackgroundTurn,
  yieldBuildTurn,
} from '#platform/vector-host'
import type { HNSWIndex } from '../hnsw'
import { insertIntoGraph } from './build-host'
import { calibrateBeforeBuild, recalibrateWhenDrifted } from './calibration'
import { releasePendingLocations } from './disk'
import { type GrowingCopyOutcome, lineageOf, placeInGrowingCopy } from './growing-copy'
import { admitShuffledRebuild, releaseMemoryCharges, releaseRebuildCharge, stopWaitingForMemory } from './memory-charge'
import { moveOutOfBuffer } from './search-writes'
import type { VectorIndexState } from './shared'
import { copyInTurns, forEachInTurns, shuffledLiveDocIdsInTurns } from './turns'
import { dropSharedGraph, invalidateWorkerCopies, noteWrite, scheduleWorkerCopyLoad } from './worker-copies'

function bufferIfTheGraphLacks(state: VectorIndexState, graph: HNSWIndex, docId: string): void {
  const ordinal = state.store.getOrdinal(docId)
  if (ordinal !== undefined && graph.holdsNode(ordinal) && !graph.holdsTombstone(ordinal)) moveOutOfBuffer(state, docId)
  else state.buffer.add(docId)
}

function bufferWhatTheGraphLacks(state: VectorIndexState, graph: HNSWIndex): void {
  for (const docId of allLiveDocIds(state)) bufferIfTheGraphLacks(state, graph, docId)
}

async function bufferWhatTheGraphLacksInTurns(state: VectorIndexState, graph: HNSWIndex): Promise<void> {
  const visit = (docId: string): void => bufferIfTheGraphLacks(state, graph, docId)
  await forEachInTurns(allLiveDocIds(state), visit, () => !state.disposed && state.hnsw === graph)
}

export async function buildGraphFromStore(state: VectorIndexState): Promise<boolean> {
  const lineage = lineageOf(state.hnsw)
  const order = turnsAreBudgeted ? await shuffledLiveDocIdsInTurns(state) : shuffleInPlace([...allLiveDocIds(state)])
  if (order === null || lineageOf(state.hnsw) !== lineage) return false
  const graph = createHNSWIndex(state.dimension, state.store, state.hnswConfig, state.osq ?? undefined)
  state.freshGraph = graph
  let completed = false
  try {
    completed = await insertIntoGraph(state, graph, order, () => true)
  } finally {
    state.freshGraph = null
  }
  if (!completed || lineageOf(state.hnsw) !== lineage) {
    dropSharedGraph(state, graph)
    return false
  }
  const replaced = state.hnsw
  adoptGraph(state, graph)
  state.shuffledBuildCount = graph.size
  noteWrite(state)
  if (turnsAreBudgeted) await bufferWhatTheGraphLacksInTurns(state, graph)
  else bufferWhatTheGraphLacks(state, graph)
  if (replaced !== null) dropSharedGraph(state, replaced)
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

export async function keepBuildsOut(state: VectorIndexState): Promise<() => void> {
  while (state.buildsKeptOut !== null) await state.buildsKeptOut.ended
  if (state.disposed) return () => undefined
  let end: () => void = () => undefined
  const ended = new Promise<void>(resolve => {
    end = resolve
  })
  const kept = { ended, end }
  state.buildsKeptOut = kept
  return () => {
    if (state.buildsKeptOut !== kept) return
    letBuildsIn(state)
    scheduleBuild(state)
  }
}

function letBuildsIn(state: VectorIndexState): void {
  const kept = state.buildsKeptOut
  state.buildsKeptOut = null
  kept?.end()
}

export async function buildExclusively(
  state: VectorIndexState,
  work: () => Promise<void>,
  waitsForShuffledRebuild = true,
  keepsBuildsOut = false,
): Promise<void> {
  for (;;) {
    if (state.pendingBuild !== null) await state.pendingBuild
    else if (waitsForShuffledRebuild && state.shuffledRebuild !== null) await state.shuffledRebuild
    else if (!keepsBuildsOut && state.buildsKeptOut !== null) await state.buildsKeptOut.ended
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
  const replacing: { lineage: object | null; loadedWithoutCount: boolean } = {
    lineage: null,
    loadedWithoutCount: false,
  }
  await buildExclusively(
    state,
    async () => {
      const graph = state.hnsw
      if (graph === null || !shuffledRebuildDue(state)) return
      const loadedWithoutCount = state.shuffledBuildCount === null
      if (!(await recalibratesForRebuild(state, graph)) || state.hnsw !== graph) return
      replacing.lineage = lineageOf(graph)
      replacing.loadedWithoutCount = loadedWithoutCount
    },
    false,
  )
  if (replacing.lineage === null || lineageOf(state.hnsw) !== replacing.lineage) return
  const adopted = await buildGraphFromStore(state)
  if (adopted && replacing.loadedWithoutCount) state.onLoadedGraphRepaired()
}

function retryWhenMemoryAllows(state: VectorIndexState): void {
  if (state.rebuildWaitTimer !== null || state.disposed) return
  const timer = setTimeout(() => {
    state.rebuildWaitTimer = null
    if (buildDue(state)) scheduleBuild(state)
    else startShuffledRebuild(state)
  }, SHUFFLED_REBUILD_MEMORY_RETRY_MS)
  timer.unref?.()
  state.rebuildWaitTimer = timer
}

export function startShuffledRebuild(state: VectorIndexState): void {
  if (state.shuffledRebuild !== null || state.disposed) return
  if (!shuffledRebuildDue(state)) {
    stopWaitingForMemory(state)
    return
  }
  if (!admitShuffledRebuild(state)) {
    retryWhenMemoryAllows(state)
    return
  }
  state.shuffledRebuild = rebuildInShuffledOrder(state)
    .catch((error: unknown) => {
      console.warn(
        `Rebuilding the graph of "${state.indexName}/${state.fieldName}" in a shuffled order failed, so the field keeps the graph it holds:`,
        error,
      )
    })
    .finally(() => {
      state.shuffledRebuild = null
      releaseRebuildCharge(state)
      scheduleBuild(state)
      scheduleWorkerCopyLoad(state)
    })
}

async function growGraph(state: VectorIndexState, graph: HNSWIndex, bufferSnapshot: Iterable<string>): Promise<void> {
  const admit = (docId: string): boolean => {
    if (state.hnsw !== graph) return false
    if (state.tombstones.has(docId) || !state.store.has(docId)) {
      state.buffer.delete(docId)
      return false
    }
    return true
  }

  if (state.osq && !state.osq.isCalibrated() && !(await calibrateBeforeBuild(state))) return

  continueAfterGrowth(state, await placeInGrowingCopy(state, graph, bufferSnapshot, admit))
}

export function continueAfterGrowth(state: VectorIndexState, outcome: GrowingCopyOutcome): void {
  if (outcome === 'waitingForMemory') retryWhenMemoryAllows(state)
  else startShuffledRebuild(state)
}

export function triggerBuild(state: VectorIndexState): void {
  if (state.building || state.buildsKeptOut !== null) return
  state.building = true

  const bufferSnapshot = turnsAreBudgeted ? null : new Set(state.buffer)
  const existingGraph = state.hnsw
  let settled = false
  let timedOut = false

  const buildPromise = (async () => {
    try {
      if (state.disposed) return
      if (existingGraph !== null) {
        const snapshot =
          bufferSnapshot ?? (await copyInTurns(state.buffer, () => !state.disposed && state.hnsw === existingGraph))
        if (snapshot === null) return
        await growGraph(state, existingGraph, snapshot)
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

function connectAfterUnfinishedPass(state: VectorIndexState, graph: HNSWIndex): void {
  graph.connectUnreached()
  state.graphsPlacedIntoSinceConnect.delete(graph)
  noteWrite(state)
}

export function connectWhereAPassStoppedEarly(state: VectorIndexState): void {
  const graph = state.hnsw
  if (graph !== null && state.graphsPlacedIntoSinceConnect.has(graph)) connectAfterUnfinishedPass(state, graph)
}

function retryAfterBackoff(state: VectorIndexState): void {
  const delayMs = Math.min(BUILD_RETRY_MAX_DELAY_MS, Math.max(BUILD_RETRY_FIRST_DELAY_MS, state.buildRetryDelayMs * 2))
  state.buildRetryDelayMs = delayMs
  if (state.buildTimer !== null) clearTimeout(state.buildTimer)
  state.buildTimer = null
  armBuildTimer(state, delayMs, () => {
    const graph = state.hnsw
    if (state.building || state.buildsKeptOut !== null) {
      retryAfterBackoff(state)
      return
    }
    if (state.buffer.size > 0 || graph === null) {
      triggerBuild(state)
      return
    }
    try {
      connectAfterUnfinishedPass(state, graph)
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
  if (state.waitingForMemory && state.rebuildWaitTimer !== null) return false
  if (state.workerCopies.enabled && state.workerCopies.host !== undefined) return true
  return state.buffer.size >= state.promotionThreshold
}

export function scheduleBuild(state: VectorIndexState): void {
  if (state.building || state.buildScheduled || state.disposed || state.buildsKeptOut !== null) return
  if (!buildDue(state)) return

  state.buildScheduled = true
  const turn = turnsAreBudgeted ? yieldBackgroundTurn() : yieldBuildTurn(state)
  const scheduled = turn.then(() => {
    state.buildScheduled = false
    if (state.scheduledBuild === scheduled) state.scheduledBuild = null
    triggerBuild(state)
  })
  state.scheduledBuild = scheduled
}

export async function awaitBuilds(state: VectorIndexState): Promise<void> {
  for (;;) {
    const running = state.pendingBuild ?? state.shuffledRebuild ?? state.scheduledBuild
    if (running === null) return
    await running
  }
}

function releaseHeldMemory(state: VectorIndexState): void {
  state.store.release()
  state.hnsw = null
  state.freshGraph = null
  state.growingCopy = null
  state.osq = null
  state.tombstones.clear()
  state.buffer.clear()
  state.pendingLocations.clear()
  state.savedFiles = []
  state.savedSignature = null
  releaseMemoryCharges(state)
}

export function disposeIndex(state: VectorIndexState): Promise<void> {
  state.disposed = true
  letBuildsIn(state)
  if (state.rebuildWaitTimer !== null) clearTimeout(state.rebuildWaitTimer)
  state.rebuildWaitTimer = null
  if (state.buildTimer !== null) clearTimeout(state.buildTimer)
  state.buildTimer = null
  invalidateWorkerCopies(state)
  const release = (): void => releaseHeldMemory(state)
  if (state.pendingBuild !== null || state.shuffledRebuild !== null || state.scheduledBuild !== null) {
    return awaitBuilds(state).then(release, release)
  }
  release()
  return Promise.resolve()
}
