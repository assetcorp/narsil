import type { VectorMetric } from '../brute-force'
import { insertNode } from '../hnsw/mutation'
import { type GraphSearchOptions, type OrdinalHit, searchOrdinals } from '../hnsw/search'
import { type HNSWGraphState, nodeCountOf, tombstoneCountOf } from '../hnsw/shared'
import { openGraphState } from '../hnsw/state'
import { openSharedQuantizer, type SharedQuantizerView } from '../osq/view'
import { openSharedVectorStore, type SharedVectorStoreView } from '../vector-store/view'
import type { GraphInsertOutcome, SharedVectorFieldHandles } from './types'

export interface SharedVectorFieldView {
  readonly handles: SharedVectorFieldHandles
  readonly store: SharedVectorStoreView
  readonly quantizer: SharedQuantizerView | undefined
  /** This is the graph state, and it reads null while the field holds no graph. */
  readonly graph: HNSWGraphState | null
  readonly liveSize: number
  /** Reports whether this thread reads every vector of the field, which reads false while the main thread has added a block whose handles it has yet to send. */
  readonly readsEveryVector: boolean
  /** Reports the document id at an ordinal, or undefined where the ordinal holds no live vector. */
  docIdOf(ordinal: number): string | undefined
  /** Reports the ordinal a document id holds, or undefined where the field holds no vector for it. */
  ordinalOf(docId: string): number | undefined
  /** Reads a document's vector, or undefined where the field holds none for it. */
  vectorOf(docId: string): Float32Array | undefined
  /** Takes handles the main thread sent again, opening any block or graph they add. */
  adopt(next: SharedVectorFieldHandles): void
  /** Closes every file descriptor this thread opened for the field's released vectors. */
  close(): void
  /** Places an ordinal's vector in the graph, writing its record first, and reports whether the node was new. */
  insertOrdinal(ordinal: number): boolean
  /** Reports how many vectors the thread placed since the last report. */
  takeOutcome(): GraphInsertOutcome
  searchOrdinals(
    query: Float32Array,
    k: number,
    metric: VectorMetric,
    minSimilarity: number,
    options: GraphSearchOptions,
  ): OrdinalHit[]
}

export function openSharedVectorField(initial: SharedVectorFieldHandles, threadSlot: number): SharedVectorFieldView {
  let handles = initial
  const store = openSharedVectorStore(initial.store, threadSlot)
  const codeLayout = initial.store.codeLayout
  const quantizer =
    initial.quantization !== 'none' && codeLayout !== null
      ? openSharedQuantizer(store, codeLayout, initial.metric)
      : undefined
  let graph: HNSWGraphState | null = null
  let ordinals: Map<string, number> | null = null
  let scanned = 0
  let placed = 0

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
    get readsEveryVector() {
      return store.holdsEveryBlock
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

    close() {
      store.close()
    },

    insertOrdinal(ordinal) {
      if (graph === null) return false
      const fresh = insertNode(graph, ordinal)
      if (fresh) placed += 1
      return fresh
    },

    takeOutcome() {
      const outcome = { placed }
      placed = 0
      return outcome
    },

    searchOrdinals(query, k, metric, minSimilarity, options) {
      if (graph === null) return []
      return searchOrdinals(graph, docIdOf, query, k, metric, minSimilarity, options)
    },
  }
}
