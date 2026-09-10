import { GRAPH_BUILD_CHUNKS_IN_FLIGHT_PER_WORKER, GRAPH_BUILD_DISPATCH_CHUNK } from '../constants'
import type { HNSWIndex } from '../hnsw'
import type { GraphInsertOutcome } from '../shared-field/types'
import { BUILD_CHUNK_SIZE, WORKER_COPY_MIN_VECTORS } from './constants'
import { liveSize, type VectorIndexState, yieldToEventLoop } from './shared'
import { shareGraph } from './worker-copies'

/**
 * Sends a batch of ordinals to a thread that places them in a graph.
 *
 * @internal
 */
export type OrdinalDispatcher = (ordinals: Int32Array) => Promise<GraphInsertOutcome | null>

interface Dispatch {
  send: OrdinalDispatcher
  workerCount: number
}

interface LocalFallback {
  warned: boolean
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

/**
 * Inserts the admitted documents into a graph, using the worker threads that
 * hold the field where the index has any and this thread otherwise. It yields
 * to the event loop between chunks, so a query can answer between them.
 *
 * A document's buffer marker clears once the graph links the ordinal the
 * index dispatched. A vector that a caller replaces while its chunk is in
 * flight therefore keeps its marker, and the next build links the
 * replacement.
 *
 * @param state The index the graph belongs to, whose disposal stops the work.
 * @param graph The graph to insert into.
 * @param docIds The documents to offer.
 * @param admit Reports whether a document goes into the graph.
 * @param inserted The index calls this after each document goes in, with
 * whether the document's vector fell outside the quantiser's calibration.
 * @returns True where the index offered every document, and false where
 * disposal stopped the work first.
 *
 * @internal
 */
export async function insertIntoGraph(
  state: VectorIndexState,
  graph: HNSWIndex,
  docIds: Iterable<string>,
  admit: (docId: string) => boolean,
  inserted?: (docId: string, outsideCalibration: boolean) => void,
): Promise<boolean> {
  const found = await dispatcherFor(state, graph)
  if (found === null) return insertLocally(state, graph, docIds, admit, inserted)
  const dispatch: Dispatch = found

  const pending = new Set<Promise<void>>()
  const limit = dispatch.workerCount * GRAPH_BUILD_CHUNKS_IN_FLIGHT_PER_WORKER
  const fallback: LocalFallback = { warned: false }
  let batchDocIds: string[] = []
  let batchOrdinals: number[] = []

  async function flush(): Promise<void> {
    if (batchOrdinals.length === 0) return
    const chunkDocIds = batchDocIds
    const chunkOrdinals = Int32Array.from(batchOrdinals)
    batchDocIds = []
    batchOrdinals = []
    if (state.sharedBlockCount !== state.store.handles.blocks.length)
      await shareGraph(state, graph, graph === state.hnsw)
    const run = placeChunk(state, graph, dispatch, chunkDocIds, chunkOrdinals, inserted, fallback).finally(() => {
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
  inserted: ((docId: string, outsideCalibration: boolean) => void) | undefined,
  fallback: LocalFallback,
): Promise<void> {
  let outcome: GraphInsertOutcome | null = null
  try {
    outcome = await dispatch.send(chunkOrdinals)
  } catch {
    outcome = null
  }
  if (state.disposed) return
  if (outcome === null) {
    if (!fallback.warned) {
      fallback.warned = true
      console.warn(
        `No worker thread placed the vectors of "${state.indexName}/${state.fieldName}", so this thread is building its graph itself`,
      )
    }
    outcome = { outsideCalibration: false }
    for (const ordinal of chunkOrdinals) {
      if (graph.insertOrdinal(ordinal))
        outcome.outsideCalibration = quantizeOrdinal(state, ordinal) || outcome.outsideCalibration
    }
  }
  for (let i = 0; i < chunkDocIds.length; i++) {
    const docId = chunkDocIds[i]
    if (state.store.getOrdinal(docId) === chunkOrdinals[i]) state.buffer.delete(docId)
    else graph.markTombstoneOrdinal(chunkOrdinals[i])
    inserted?.(docId, outcome.outsideCalibration)
  }
}

function quantizeOrdinal(state: VectorIndexState, ordinal: number): boolean {
  const sq8 = state.sq8
  if (sq8 === null || !sq8.isCalibrated()) return false
  const docId = state.store.docIdForOrdinal(ordinal)
  const entry = state.store.entryForOrdinal(ordinal)
  if (docId === undefined || entry === undefined) return false
  const outside = sq8.needsRecalibration(entry.vector)
  sq8.quantize(docId, entry.vector)
  return outside
}

async function insertLocally(
  state: VectorIndexState,
  graph: HNSWIndex,
  docIds: Iterable<string>,
  admit: (docId: string) => boolean,
  inserted: ((docId: string, outsideCalibration: boolean) => void) | undefined,
): Promise<boolean> {
  let count = 0
  for (const docId of docIds) {
    if (state.disposed) return false
    if (!admit(docId)) continue
    const ordinal = state.store.getOrdinal(docId)
    if (ordinal === undefined) continue
    const fresh = graph.insertOrdinal(ordinal)
    const outside = fresh ? quantizeOrdinal(state, ordinal) : false
    state.buffer.delete(docId)
    inserted?.(docId, outside)
    count += 1
    if (count % BUILD_CHUNK_SIZE === 0) {
      await yieldToEventLoop()
    }
  }
  return !state.disposed
}
