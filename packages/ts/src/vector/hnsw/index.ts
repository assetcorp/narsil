import type { ScoredDocument, VectorEntry } from '../../types/internal'
import type { VectorMetric } from '../brute-force'
import type { OsqQuantizer } from '../osq/types'
import type { VectorStore } from '../vector-store'
import { adjacencySlots, graphBytes, hasNode } from './adjacency'
import { COMPACTION_ABSOLUTE_THRESHOLD, COMPACTION_TOMBSTONE_RATIO } from './constants'
import { createSharedGraphHandles, type SharedGraphHandles } from './handles'
import { lockGraphExclusive, unlockGraphExclusive } from './locks'
import {
  compactTombstones as compactTombstonesOp,
  insertNode as insertNodeOp,
  markTombstone as markTombstoneOp,
  rebuild as rebuildOp,
  resetGraph,
} from './mutation'
import { deserializeNumberedGraph, type NumberedHnswGraph, serializeNumberedGraph } from './numbered-graph'
import { deserializeGraph, serializeGraph } from './persistence'
import { searchScratchBytes } from './scratch-bytes'
import { type GraphSearchOptions, search as searchOp } from './search'
import {
  entryPointOf,
  type HNSWConfig,
  type HNSWGraphState,
  isTombstoned,
  nodeCountOf,
  type SerializedHNSWGraph,
  tombstoneCountOf,
  topLayerOf,
} from './shared'
import { exportSnapshot, type HNSWSnapshot, restoreSnapshot } from './snapshot'
import { openGraphState } from './state'

export type { SharedGraphHandles } from './handles'
export type { NumberedHnswGraph } from './numbered-graph'
export type { GraphSearchOptions } from './search'
export type { HNSWConfig, SerializedHNSWGraph } from './shared'
export type { HNSWSnapshot } from './snapshot'

export interface HNSWIndex {
  readonly dimension: number
  readonly size: number
  readonly tombstoneCount: number
  readonly entryPointId: string | null
  readonly topLayer: number
  readonly m: number
  readonly efConstruction: number
  readonly metric: VectorMetric
  /**
   * The graph's shared structures hold this many bytes, read from each
   * structure as it stands, covering the adjacency arrays, the node levels,
   * the lock words, and the tombstone bytes.
   */
  readonly graphBytes: number
  readonly searchScratchBytes: number
  /** Another thread opens these shared structures to search or extend this graph in place. */
  readonly handles: SharedGraphHandles

  insertNode(docId: string): void
  insertOrdinal(ordinal: number): boolean
  markTombstone(docId: string): void
  markTombstoneOrdinal(ordinal: number): void
  has(docId: string): boolean
  isTombstoned(docId: string): boolean
  search(
    query: Float32Array,
    k: number,
    searchMetric: VectorMetric,
    minSimilarity: number,
    options?: GraphSearchOptions,
  ): ScoredDocument[]
  clear(): void
  entries(): IterableIterator<[string, VectorEntry]>
  compactionNeeded(): boolean
  compactTombstones(): void
  rebuild(): void
  /** Performs an operation that rewrites the graph in place while every other thread waits. */
  exclusively<T>(operation: () => T): T

  serialize(): SerializedHNSWGraph
  deserialize(data: SerializedHNSWGraph): void
  /** Writes the graph with each vector named by the number that `numberOfOrdinal` gives its ordinal, and it leaves out every node whose ordinal has no number. */
  serializeNumbered(numberOfOrdinal: Int32Array, ordinalOfNumber: Int32Array): NumberedHnswGraph
  /** Reads a numbered graph back, placing each node at the ordinal that `ordinalOfNumber` gives its number. */
  deserializeNumbered(graph: NumberedHnswGraph, ordinalOfNumber: Int32Array): void
  exportSnapshot(): HNSWSnapshot
  restoreSnapshot(snapshot: HNSWSnapshot): void
}

export function createHNSWIndexFromSnapshot(store: VectorStore, snapshot: HNSWSnapshot): HNSWIndex {
  const index = createHNSWIndex(snapshot.dimension, store, {
    m: snapshot.m,
    efConstruction: snapshot.efConstruction,
    metric: snapshot.metric,
  })
  index.restoreSnapshot(snapshot)
  return index
}

export function createHNSWIndex(
  dimension: number,
  store: VectorStore,
  config?: HNSWConfig,
  quantizer?: OsqQuantizer,
  handles?: SharedGraphHandles,
): HNSWIndex {
  const M = config?.m ?? 16
  const shared =
    handles ??
    createSharedGraphHandles({
      m: M,
      mMax0: M * 2,
      efConstruction: config?.efConstruction ?? 200,
      metric: config?.metric ?? 'cosine',
    })
  const state: HNSWGraphState = openGraphState(shared, dimension, store, quantizer, 0)
  const docIdOf = (ord: number) => store.docIdForOrdinal(ord)

  function exclusively<T>(operation: () => T): T {
    lockGraphExclusive(state.locks)
    try {
      return operation()
    } finally {
      unlockGraphExclusive(state.locks)
    }
  }

  function insertNode(docId: string): void {
    const ord = store.getOrdinal(docId)
    if (ord === undefined) {
      throw new Error(`Cannot insert HNSW node: vector for "${docId}" not found in VectorStore`)
    }
    const entry = store.entryForOrdinal(ord)
    if (!entry) {
      throw new Error(`Cannot insert HNSW node: vector for "${docId}" not found in VectorStore`)
    }
    if (entry.vector.length !== dimension) {
      throw new Error(`Vector dimension mismatch: expected ${dimension}, got ${entry.vector.length}`)
    }
    insertNodeOp(state, ord)
  }

  function* entriesIterator(): IterableIterator<[string, VectorEntry]> {
    const slots = adjacencySlots(state.adjacency)
    for (let ord = 0; ord < slots; ord++) {
      if (!hasNode(state.adjacency, ord)) continue
      if (isTombstoned(state, ord)) continue
      const docId = store.docIdForOrdinal(ord)
      if (docId === undefined) continue
      const entry = store.entryForOrdinal(ord)
      if (!entry) continue
      yield [docId, { docId, vector: entry.vector, magnitude: entry.magnitude }]
    }
  }

  function compactionNeeded(): boolean {
    const nodeCount = nodeCountOf(state)
    if (nodeCount === 0) return false
    const tombstones = tombstoneCountOf(state)
    return tombstones / nodeCount > COMPACTION_TOMBSTONE_RATIO || tombstones > COMPACTION_ABSOLUTE_THRESHOLD
  }

  return {
    get dimension() {
      return dimension
    },
    get size() {
      return nodeCountOf(state) - tombstoneCountOf(state)
    },
    get tombstoneCount() {
      return tombstoneCountOf(state)
    },
    get entryPointId() {
      const entryPoint = entryPointOf(state)
      return entryPoint === -1 ? null : (store.docIdForOrdinal(entryPoint) ?? null)
    },
    get topLayer() {
      return topLayerOf(state)
    },
    get m() {
      return state.M
    },
    get efConstruction() {
      return state.efCons
    },
    get metric() {
      return state.buildMetric
    },
    get graphBytes() {
      return graphBytes(state.adjacency)
    },
    get searchScratchBytes() {
      return searchScratchBytes(state)
    },
    get handles() {
      return shared
    },
    insertNode,
    insertOrdinal: (ordinal: number) => insertNodeOp(state, ordinal),
    markTombstone: (docId: string) => {
      const ord = store.getOrdinal(docId)
      if (ord !== undefined) markTombstoneOp(state, ord)
    },
    markTombstoneOrdinal: (ordinal: number) => markTombstoneOp(state, ordinal),
    has: (docId: string) => {
      const ord = store.getOrdinal(docId)
      return ord !== undefined && hasNode(state.adjacency, ord) && !isTombstoned(state, ord)
    },
    isTombstoned: (docId: string) => {
      const ord = store.getOrdinal(docId)
      return ord !== undefined && isTombstoned(state, ord)
    },
    search: (
      query: Float32Array,
      k: number,
      searchMetric: VectorMetric,
      minSimilarity: number,
      options?: GraphSearchOptions,
    ) => searchOp(state, docIdOf, query, k, searchMetric, minSimilarity, options),
    clear: () => exclusively(() => resetGraph(state)),
    entries: entriesIterator,
    compactionNeeded,
    compactTombstones: () => exclusively(() => compactTombstonesOp(state)),
    rebuild: () => exclusively(() => rebuildOp(state)),
    exclusively,
    serialize: () => serializeGraph(state, store),
    deserialize: (data: SerializedHNSWGraph) => exclusively(() => deserializeGraph(state, store, data)),
    serializeNumbered: (numberOfOrdinal: Int32Array, ordinalOfNumber: Int32Array) =>
      serializeNumberedGraph(state, numberOfOrdinal, ordinalOfNumber),
    deserializeNumbered: (graph: NumberedHnswGraph, ordinalOfNumber: Int32Array) =>
      exclusively(() => deserializeNumberedGraph(state, graph, ordinalOfNumber)),
    exportSnapshot: () => exportSnapshot(state),
    restoreSnapshot: (snapshot: HNSWSnapshot) => exclusively(() => restoreSnapshot(state, snapshot)),
  }
}
