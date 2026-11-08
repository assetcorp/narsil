import {
  COMPACTION_ABSOLUTE_THRESHOLD,
  COMPACTION_TOMBSTONE_RATIO,
  ErrorCodes,
  NarsilError,
} from '#platform/vector-core-host'
import type { VectorEntry } from '../../types/internal'
import { withTransientAdmission, withTransientAdmissionAsync } from '../admission'
import type { VectorMetric } from '../brute-force'
import type { OsqQuantizer } from '../osq/types'
import type { VectorStore } from '../vector-store'
import { adjacencySlots, graphBytes, hasNode } from './adjacency'
import { connectOffThread, connectOnThisThread } from './connect-in-turns'
import { connectAfterBuild } from './connect-unreached'
import { createSharedGraphHandles, GRAPH_RETIRED, GRAPH_UNLINKED_NODES, type SharedGraphHandles } from './handles'
import { lockGraphExclusive, unlockGraphExclusive } from './locks'
import {
  compactTombstones as compactTombstonesOp,
  insertNode as insertNodeOp,
  markTombstone as markTombstoneOp,
  rebuild as rebuildOp,
  resetGraph,
} from './mutation'
import {
  deserializeNumberedGraph,
  type NumberedGraphParts,
  type NumberedHnswGraph,
  serializeNumberedGraphParts,
} from './numbered-graph'
import { deserializeGraph } from './persistence'
import { searchScratchBytes } from './scratch-bytes'
import { type GraphSearchOptions, type ResolvedHit, search as searchOp } from './search'
import { searchOffThread as searchOffThreadOp } from './search-off-thread'
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
export type { NumberedGraphParts, NumberedHnswGraph } from './numbered-graph'
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

  readonly holdsUnlinkedNode: boolean

  insertNode(docId: string): void
  insertOrdinal(ordinal: number, connectsAfterwards?: boolean): boolean
  markTombstone(docId: string): void
  markTombstoneOrdinal(ordinal: number): void
  holdsNode(ordinal: number): boolean
  holdsTombstone(ordinal: number): boolean
  has(docId: string): boolean
  isTombstoned(docId: string): boolean
  search(
    query: Float32Array,
    k: number,
    searchMetric: VectorMetric,
    minSimilarity: number,
    options?: GraphSearchOptions,
  ): ResolvedHit[]
  /** Walks the graph on a native thread, or answers `null` when the native core has no threads of its own. */
  searchOffThread(
    query: Float32Array,
    k: number,
    searchMetric: VectorMetric,
    minSimilarity: number,
    options: GraphSearchOptions,
  ): Promise<ResolvedHit[] | null>
  clear(): void
  retire(): void
  entries(): IterableIterator<[string, VectorEntry]>
  compactionNeeded(): boolean
  /** Takes out of the graph every tombstoned node whose ordinal every pin leaves out, given the oldest pin that any thread holds. */
  compactTombstones(oldestPin: number): void
  connectUnreached(): void
  connectOffThread(): Promise<boolean> | null
  connectOnThisThread(inSlices: boolean): Promise<void>
  rebuild(): void
  /** Performs an operation that rewrites the graph in place while every other thread waits. */
  exclusively<T>(operation: () => T): T

  deserialize(data: SerializedHNSWGraph): void
  /** Writes the graph in parts of `partSize` numbers. Each vector takes the number that `numberOfOrdinal` returns for its ordinal, and the method skips every node whose ordinal has no number. */
  serializeNumbered(numberOfOrdinal: Int32Array, ordinalOfNumber: Int32Array, partSize: number): NumberedHnswGraph[]
  /** Reads a numbered graph back from its parts, and places each node at the ordinal that `ordinalOfNumber` returns for the node's number. */
  deserializeNumbered(graph: NumberedGraphParts, ordinalOfNumber: Int32Array): void
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

  function relinking<T>(operation: () => T): T {
    return exclusively(() => {
      state.linkWrites += 1
      return operation()
    })
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
      throw new NarsilError(
        ErrorCodes.VECTOR_DIMENSION_MISMATCH,
        `Vector dimension mismatch: expected ${dimension}, got ${entry.vector.length}`,
        { docId, expected: dimension, received: entry.vector.length },
      )
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
    get holdsUnlinkedNode() {
      return Atomics.load(state.header, GRAPH_UNLINKED_NODES) !== 0
    },
    insertNode,
    insertOrdinal: (ordinal: number, connectsAfterwards = false) =>
      insertNodeOp(state, ordinal, false, connectsAfterwards),
    markTombstone: (docId: string) => {
      const ord = store.getOrdinal(docId)
      if (ord !== undefined) markTombstoneOp(state, ord)
    },
    markTombstoneOrdinal: (ordinal: number) => markTombstoneOp(state, ordinal),
    holdsNode: (ordinal: number) => hasNode(state.adjacency, ordinal),
    holdsTombstone: (ordinal: number) => hasNode(state.adjacency, ordinal) && isTombstoned(state, ordinal),
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
      options: GraphSearchOptions = {},
    ) =>
      options.admission !== undefined
        ? searchOp(state, docIdOf, query, k, searchMetric, minSimilarity, options)
        : withTransientAdmission(store.view, admission =>
            searchOp(state, docIdOf, query, k, searchMetric, minSimilarity, { ...options, admission }),
          ),
    searchOffThread: (
      query: Float32Array,
      k: number,
      searchMetric: VectorMetric,
      minSimilarity: number,
      options: GraphSearchOptions,
    ) =>
      options.admission !== undefined
        ? searchOffThreadOp(state, docIdOf, query, k, searchMetric, minSimilarity, options)
        : withTransientAdmissionAsync(store.view, admission =>
            searchOffThreadOp(state, docIdOf, query, k, searchMetric, minSimilarity, { ...options, admission }),
          ),
    clear: () => relinking(() => resetGraph(state)),
    retire: () => Atomics.store(shared.header, GRAPH_RETIRED, 1),
    entries: entriesIterator,
    compactionNeeded,
    compactTombstones: (oldestPin: number) =>
      relinking(() => compactTombstonesOp(state, ord => store.mayFreeOrdinal(ord, oldestPin))),
    connectUnreached: () => relinking(() => connectAfterBuild(state)),
    connectOffThread: () => connectOffThread(state),
    connectOnThisThread: (inSlices: boolean) => connectOnThisThread(state, inSlices),
    rebuild: () => relinking(() => rebuildOp(state)),
    exclusively,
    deserialize: (data: SerializedHNSWGraph) => relinking(() => deserializeGraph(state, store, data)),
    serializeNumbered: (numberOfOrdinal: Int32Array, ordinalOfNumber: Int32Array, partSize: number) =>
      serializeNumberedGraphParts(state, numberOfOrdinal, ordinalOfNumber, partSize),
    deserializeNumbered: (graph: NumberedGraphParts, ordinalOfNumber: Int32Array) =>
      relinking(() => deserializeNumberedGraph(state, graph, ordinalOfNumber)),
    exportSnapshot: () => exportSnapshot(state),
    restoreSnapshot: (snapshot: HNSWSnapshot) => relinking(() => restoreSnapshot(state, snapshot)),
  }
}
