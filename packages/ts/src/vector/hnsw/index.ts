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
  type HNSWNode,
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
    nodes: new Map<string, HNSWNode>(),
    tombstones: new Set<string>(),
    entryPointId: null,
    topLayer: -1,
  }

  function clear(): void {
    state.nodes.clear()
    state.tombstones.clear()
    state.entryPointId = null
    state.topLayer = -1
  }

  function* entriesIterator(): IterableIterator<[string, VectorEntry]> {
    for (const [docId] of state.nodes) {
      if (state.tombstones.has(docId)) continue
      const entry = state.store.get(docId)
      if (!entry) continue
      yield [docId, { docId, vector: entry.vector, magnitude: entry.magnitude }]
    }
  }

  function compactionNeeded(): boolean {
    if (state.nodes.size === 0) return false
    return (
      state.tombstones.size / state.nodes.size > COMPACTION_TOMBSTONE_RATIO ||
      state.tombstones.size > COMPACTION_ABSOLUTE_THRESHOLD
    )
  }

  return {
    get dimension() {
      return state.dimension
    },
    get size() {
      return state.nodes.size - state.tombstones.size
    },
    get tombstoneCount() {
      return state.tombstones.size
    },
    get entryPointId() {
      return state.entryPointId
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
    has: (docId: string) => state.nodes.has(docId) && !state.tombstones.has(docId),
    isTombstoned: (docId: string) => state.tombstones.has(docId),
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
