import type { ScoredDocument, VectorEntry } from '../../types/internal'
import type { VectorMetric } from '../brute-force'
import type { ScalarQuantizer } from '../scalar-quantization'
import type { VectorStore } from '../vector-store'
import {
  compactTombstones as compactTombstonesOp,
  insertNode as insertNodeOp,
  markTombstone as markTombstoneOp,
  rebuild as rebuildOp,
} from './mutation'
import { deserializeGraph, serializeGraph } from './persistence'
import { search as searchOp } from './search'
import {
  COMPACTION_ABSOLUTE_THRESHOLD,
  COMPACTION_TOMBSTONE_RATIO,
  type HNSWConfig,
  type HNSWGraphState,
  type SerializedHNSWGraph,
} from './shared'

export type { HNSWConfig, SerializedHNSWGraph } from './shared'

export interface HNSWIndex {
  readonly dimension: number
  readonly size: number
  readonly tombstoneCount: number
  readonly entryPointId: string | null
  readonly topLayer: number
  readonly m: number
  readonly efConstruction: number
  readonly metric: VectorMetric

  insertNode(docId: string): void
  markTombstone(docId: string): void
  has(docId: string): boolean
  isTombstoned(docId: string): boolean
  search(
    query: Float32Array,
    k: number,
    searchMetric: VectorMetric,
    minSimilarity: number,
    filterDocIds?: Set<string>,
    efSearch?: number,
  ): ScoredDocument[]
  clear(): void
  entries(): IterableIterator<[string, VectorEntry]>
  compactionNeeded(): boolean
  compactTombstones(): void
  rebuild(): void

  serialize(): SerializedHNSWGraph
  deserialize(data: SerializedHNSWGraph): void
}

export function createHNSWIndex(
  dimension: number,
  store: VectorStore,
  config?: HNSWConfig,
  quantizer?: ScalarQuantizer,
): HNSWIndex {
  const M = config?.m ?? 16
  const Mmax0 = M * 2
  const efCons = config?.efConstruction ?? 200
  const buildMetric = config?.metric ?? 'cosine'
  const mL = 1 / Math.log(M)

  const state: HNSWGraphState = {
    dimension,
    store,
    quantizer,
    M,
    Mmax0,
    efCons,
    buildMetric,
    mL,
    nodesByOrd: [],
    tombstones: new Uint8Array(0),
    tombstoneCount: 0,
    nodeCount: 0,
    capacity: 0,
    visited: new Uint32Array(0),
    visitStamp: 0,
    entryPointOrd: -1,
    topLayer: -1,
  }

  function clear(): void {
    state.nodesByOrd = []
    state.tombstones = new Uint8Array(0)
    state.tombstoneCount = 0
    state.nodeCount = 0
    state.capacity = 0
    state.visited = new Uint32Array(0)
    state.visitStamp = 0
    state.entryPointOrd = -1
    state.topLayer = -1
  }

  function* entriesIterator(): IterableIterator<[string, VectorEntry]> {
    for (let ord = 0; ord < state.nodesByOrd.length; ord++) {
      if (state.nodesByOrd[ord] === undefined) continue
      if (state.tombstones[ord] === 1) continue
      const docId = state.store.docIdForOrdinal(ord)
      if (docId === undefined) continue
      const entry = state.store.entryForOrdinal(ord)
      if (!entry) continue
      yield [docId, { docId, vector: entry.vector, magnitude: entry.magnitude }]
    }
  }

  function compactionNeeded(): boolean {
    if (state.nodeCount === 0) return false
    return (
      state.tombstoneCount / state.nodeCount > COMPACTION_TOMBSTONE_RATIO ||
      state.tombstoneCount > COMPACTION_ABSOLUTE_THRESHOLD
    )
  }

  return {
    get dimension() {
      return state.dimension
    },
    get size() {
      return state.nodeCount - state.tombstoneCount
    },
    get tombstoneCount() {
      return state.tombstoneCount
    },
    get entryPointId() {
      return state.entryPointOrd === -1 ? null : (state.store.docIdForOrdinal(state.entryPointOrd) ?? null)
    },
    get topLayer() {
      return state.topLayer
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
    insertNode: (docId: string) => insertNodeOp(state, docId),
    markTombstone: (docId: string) => markTombstoneOp(state, docId),
    has: (docId: string) => {
      const ord = state.store.getOrdinal(docId)
      return ord !== undefined && state.nodesByOrd[ord] !== undefined && state.tombstones[ord] !== 1
    },
    isTombstoned: (docId: string) => {
      const ord = state.store.getOrdinal(docId)
      return ord !== undefined && state.tombstones[ord] === 1
    },
    search: (
      query: Float32Array,
      k: number,
      searchMetric: VectorMetric,
      minSimilarity: number,
      filterDocIds?: Set<string>,
      efSearch?: number,
    ) => searchOp(state, query, k, searchMetric, minSimilarity, filterDocIds, efSearch),
    clear,
    entries: entriesIterator,
    compactionNeeded,
    compactTombstones: () => compactTombstonesOp(state),
    rebuild: () => rebuildOp(state),
    serialize: () => serializeGraph(state),
    deserialize: (data: SerializedHNSWGraph) => deserializeGraph(state, data),
  }
}
