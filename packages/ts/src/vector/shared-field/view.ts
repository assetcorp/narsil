import type { VectorMetric } from '../brute-force'
import { insertNode } from '../hnsw/mutation'
import { type OrdinalHit, searchOrdinals } from '../hnsw/search'
import { type HNSWGraphState, nodeCountOf, tombstoneCountOf } from '../hnsw/shared'
import { openGraphState } from '../hnsw/state'
import type { OrdinalFilter } from '../ordinal-filter'
import { openSharedQuantizer, type SharedQuantizerView } from '../scalar-quantization-view'
import { openSharedVectorStore, type SharedVectorStoreView } from '../vector-store/view'
import type { GraphInsertOutcome, SharedVectorFieldHandles } from './types'

/**
 * This is one thread's open view over a vector field, holding the readers
 * over its shared vectors and codes alongside the graph state the thread
 * searches and extends once the field holds a graph.
 *
 * @internal
 */
export interface SharedVectorFieldView {
  readonly handles: SharedVectorFieldHandles
  readonly store: SharedVectorStoreView
  readonly quantizer: SharedQuantizerView | undefined
  /** This is the graph state, and it reads null while the field holds no graph. */
  readonly graph: HNSWGraphState | null
  readonly liveSize: number
  /** Reports the document id at an ordinal, or undefined where the ordinal holds no live vector. */
  docIdOf(ordinal: number): string | undefined
  /** Reports the ordinal a document id holds, or undefined where the field holds no vector for it. */
  ordinalOf(docId: string): number | undefined
  /** Reads a document's vector, or undefined where the field holds none for it. */
  vectorOf(docId: string): Float32Array | undefined
  /** Takes handles the main thread sent again, opening any block or graph they add. */
  adopt(next: SharedVectorFieldHandles): void
  /** Places an ordinal's vector in the graph and writes its codes, reporting whether the node was new. */
  insertOrdinal(ordinal: number): boolean
  /** Reports whether a vector placed since the last report fell outside the quantiser's calibration. */
  takeOutcome(): GraphInsertOutcome
  searchOrdinals(
    query: Float32Array,
    k: number,
    metric: VectorMetric,
    minSimilarity: number,
    filter: OrdinalFilter | undefined,
    efSearch: number | undefined,
  ): OrdinalHit[]
}

function outsideCalibration(quantizer: SharedQuantizerView, vector: Float32Array): boolean {
  const { alpha, offset } = quantizer.constants()
  const upper = offset + alpha * 255
  for (let d = 0; d < vector.length; d++) {
    if (vector[d] < offset || vector[d] > upper) return true
  }
  return false
}

/**
 * Opens a field on the current thread.
 *
 * @param initial The handles to open.
 * @param threadSlot This thread's scratch slot inside every block and its
 * slot in the graph's lock record.
 * @returns The view.
 *
 * @internal
 */
export function openSharedVectorField(initial: SharedVectorFieldHandles, threadSlot: number): SharedVectorFieldView {
  let handles = initial
  const store = openSharedVectorStore(initial.store, threadSlot)
  const quantizer = initial.quantization === 'sq8' ? openSharedQuantizer(store) : undefined
  let graph: HNSWGraphState | null = null
  let ordinals: Map<string, number> | null = null
  let scanned = 0
  let outside = false

  function openGraph(next: SharedVectorFieldHandles): void {
    graph = next.graph === null ? null : openGraphState(next.graph, next.dimension, store, quantizer, threadSlot)
  }
  openGraph(initial)

  function docIdOf(ordinal: number): string | undefined {
    if (!store.holdsOrdinal(ordinal)) return undefined
    return store.docIdAt(ordinal)
  }

  function ordinalOf(docId: string): number | undefined {
    const slots = store.slots
    if (ordinals === null) ordinals = new Map()
    for (; scanned < slots; scanned++) {
      const id = store.docIdAt(scanned)
      if (id !== undefined) ordinals.set(id, scanned)
    }
    const ordinal = ordinals.get(docId)
    return ordinal !== undefined && store.holdsOrdinal(ordinal) ? ordinal : undefined
  }

  return {
    get handles() {
      return handles
    },
    store,
    quantizer,
    get graph() {
      return graph
    },
    get liveSize() {
      return graph === null ? 0 : nodeCountOf(graph) - tombstoneCountOf(graph)
    },
    docIdOf,
    ordinalOf,

    vectorOf(docId) {
      const ordinal = ordinalOf(docId)
      return ordinal === undefined ? undefined : store.vectorAt(ordinal)
    },

    adopt(next) {
      store.adoptHandles(next.store)
      if (next.graph?.header !== handles.graph?.header) openGraph(next)
      handles = next
    },

    insertOrdinal(ordinal) {
      if (graph === null) return false
      const fresh = insertNode(graph, ordinal)
      if (fresh && quantizer !== undefined && quantizer.isCalibrated()) {
        const vector = store.vectorAt(ordinal)
        if (outsideCalibration(quantizer, vector)) outside = true
        quantizer.writeCodes(ordinal, vector)
      }
      return fresh
    },

    takeOutcome() {
      const outcome = { outsideCalibration: outside }
      outside = false
      return outcome
    },

    searchOrdinals(query, k, metric, minSimilarity, filter, efSearch) {
      if (graph === null) return []
      return searchOrdinals(graph, docIdOf, query, k, metric, minSimilarity, filter, efSearch)
    },
  }
}
