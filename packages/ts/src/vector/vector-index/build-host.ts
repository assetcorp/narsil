import { GRAPH_BUILD_CHUNKS_IN_FLIGHT_PER_WORKER, GRAPH_BUILD_DISPATCH_CHUNK } from '../constants'
import type { HNSWIndex } from '../hnsw'
import type { GraphInsertOutcome } from '../shared-field/types'
import { BUILD_CHUNK_SIZE, WORKER_COPY_MIN_VECTORS } from './constants'
import { liveSize, threadsHoldCurrentLayout, type VectorIndexState, yieldToEventLoop } from './shared'
import { shareGraph } from './worker-copies'

export type OrdinalDispatcher = (ordinals: Int32Array) => Promise<GraphInsertOutcome | null>

interface Dispatch {
  send: OrdinalDispatcher
  workerCount: number
}

interface PlacementFallback {
  noWorkerWarned: boolean
  shortAnswerWarned: boolean
}

async function dispatcherFor(state: VectorIndexState, graph: HNSWIndex): Promise<Dispatch | null> {
  if (!state.workerCopies.enabled || state.disposed) return null
  const host = state.workerCopies.host
  if (host !== undefined) {
    if (!host.holdsIndex(state.indexName)) return null
    const handle = await shareGraph(state, graph, graph === state.hnsw)
    if (handle === null) return null
    return {
      send: ordinals => host.insertOrdinals(state.indexName, state.fieldName, handle, ordinals),
      workerCount: Math.max(1, host.workerCount),
    }
  }
  if (liveSize(state) < WORKER_COPY_MIN_VECTORS) return null
  const handle = await shareGraph(state, graph, graph === state.hnsw)
  const pool = state.workerCopyPool
  if (handle === null || pool === null || state.sharedHandles.get(graph)?.mode !== 'shared') return null
  return {
    send: ordinals => pool.insertOrdinals(handle, ordinals),
    workerCount: Math.max(1, pool.workerCount),
  }
}

export async function insertIntoGraph(
  state: VectorIndexState,
  graph: HNSWIndex,
  docIds: Iterable<string>,
  admit: (docId: string) => boolean,
): Promise<boolean> {
  const found = await dispatcherFor(state, graph)
  if (found === null) return insertLocally(state, graph, docIds, admit)
  const dispatch: Dispatch = found

  const pending = new Set<Promise<void>>()
  const limit = dispatch.workerCount * GRAPH_BUILD_CHUNKS_IN_FLIGHT_PER_WORKER
  const fallback: PlacementFallback = { noWorkerWarned: false, shortAnswerWarned: false }
  let batchDocIds: string[] = []
  let batchOrdinals: number[] = []

  async function flush(): Promise<void> {
    if (batchOrdinals.length === 0) return
    const chunkDocIds = batchDocIds
    const chunkOrdinals = Int32Array.from(batchOrdinals)
    batchDocIds = []
    batchOrdinals = []
    if (!threadsHoldCurrentLayout(state)) await shareGraph(state, graph, graph === state.hnsw)
    const run = placeChunk(state, graph, dispatch, chunkDocIds, chunkOrdinals, fallback).finally(() => {
      pending.delete(run)
    })
    pending.add(run)
    if (pending.size >= limit) await Promise.race(pending)
  }

  for (const docId of docIds) {
    if (state.disposed) break
    if (!admit(docId)) continue
    const ordinal = state.store.getOrdinal(docId)
    if (ordinal === undefined) continue
    batchDocIds.push(docId)
    batchOrdinals.push(ordinal)
    if (batchOrdinals.length >= GRAPH_BUILD_DISPATCH_CHUNK) await flush()
  }
  await flush()
  await Promise.all(pending)
  return !state.disposed
}

async function placeChunk(
  state: VectorIndexState,
  graph: HNSWIndex,
  dispatch: Dispatch,
  chunkDocIds: string[],
  chunkOrdinals: Int32Array,
  fallback: PlacementFallback,
): Promise<void> {
  let outcome: GraphInsertOutcome | null = null
  try {
    outcome = await dispatch.send(chunkOrdinals)
  } catch {
    outcome = null
  }
  if (state.disposed) return
  if (outcome === null) {
    if (!fallback.noWorkerWarned) {
      fallback.noWorkerWarned = true
      console.warn(
        `No worker thread placed the vectors of "${state.indexName}/${state.fieldName}", so this thread is building its graph itself`,
      )
    }
    for (const ordinal of chunkOrdinals) graph.insertOrdinal(ordinal)
  }
  let placedHere = 0
  for (let i = 0; i < chunkDocIds.length; i++) {
    const docId = chunkDocIds[i]
    const ordinal = chunkOrdinals[i]
    if (state.store.getOrdinal(docId) !== ordinal) {
      graph.markTombstoneOrdinal(ordinal)
      continue
    }
    if (!state.tombstones.has(docId) && !graph.has(docId) && graph.insertOrdinal(ordinal)) placedHere += 1
    state.buffer.delete(docId)
  }
  if (placedHere > 0 && outcome !== null && !fallback.shortAnswerWarned) {
    fallback.shortAnswerWarned = true
    console.warn(
      `A worker thread answered a chunk of "${state.indexName}/${state.fieldName}" without placing ${placedHere} of its vectors, so this thread placed them itself`,
    )
  }
}

async function insertLocally(
  state: VectorIndexState,
  graph: HNSWIndex,
  docIds: Iterable<string>,
  admit: (docId: string) => boolean,
): Promise<boolean> {
  let count = 0
  for (const docId of docIds) {
    if (state.disposed) return false
    if (!admit(docId)) continue
    const ordinal = state.store.getOrdinal(docId)
    if (ordinal === undefined) continue
    graph.insertOrdinal(ordinal)
    state.buffer.delete(docId)
    count += 1
    if (count % BUILD_CHUNK_SIZE === 0) {
      await yieldToEventLoop()
    }
  }
  return !state.disposed
}
