import type { VectorMetric } from '../brute-force'
import { fixedView } from '../shared-buffers/growable'
import { adjacencySlots, ensureAdjacencyCapacity, ensureUpperCapacity, rebindNodes, upperUsed } from './adjacency'
import {
  GRAPH_ENTRY_POINT,
  GRAPH_NODE_COUNT,
  GRAPH_SLOTS,
  GRAPH_TOMBSTONE_COUNT,
  GRAPH_TOP_LAYER,
  GRAPH_UPPER_USED,
} from './handles'
import { resetGraph } from './mutation'
import { type HNSWGraphState, reachTombstone } from './shared'

/**
 * This holds a built graph copied out flat, which the engine sends to another
 * thread where the runtime shares no memory.
 *
 * @internal
 */
export interface HNSWSnapshot {
  /** Every vector of the field has this many components. */
  dimension: number
  /** Each node keeps this many neighbours per layer. */
  m: number
  /** The builder explored this many candidates while placing each node. */
  efConstruction: number
  /** The graph ranks by this metric. */
  metric: VectorMetric
  /** Every node of the graph lies below this ordinal. */
  slots: number
  /** The upper-layer arena holds this many entries in use. */
  upperUsed: number
  /** This holds each ordinal's top layer plus one, and it reads zero where the graph holds no node there. */
  nodeLevels: Uint8Array
  /** This holds the base layer's neighbours, a count followed by that many neighbours for each ordinal. */
  level0: Int32Array
  /** This holds where each ordinal's upper layers start plus one, and it reads zero where the ordinal reaches none. */
  upperBase: Int32Array
  /** This holds every upper layer's neighbours, a count followed by that many neighbours for each layer. */
  upper: Int32Array
  /** This holds one byte per ordinal, which reads 1 once a caller removes the document. */
  tombstones: Uint8Array
  /** The graph holds this many tombstoned ordinals. */
  tombstoneCount: number
  /** The graph holds this many nodes, tombstoned ones included. */
  nodeCount: number
  /** Every search starts at this ordinal, and it is -1 while the graph is empty. */
  entryPointOrd: number
  /** The graph reaches this many layers. */
  topLayer: number
}

/**
 * Copies a graph out of its shared buffers into flat arrays the engine can
 * clone to another thread.
 *
 * @param state The graph to copy.
 * @returns The snapshot.
 *
 * @internal
 */
export function exportSnapshot(state: HNSWGraphState): HNSWSnapshot {
  const adj = state.adjacency
  const slots = adjacencySlots(adj)
  const used = upperUsed(adj)
  const stride = adj.level0Stride
  rebindNodes(adj)
  reachTombstone(state, slots)
  return {
    dimension: state.dimension,
    m: state.M,
    efConstruction: state.efCons,
    metric: state.buildMetric,
    slots,
    upperUsed: used,
    nodeLevels: adj.nodeLevels.slice(0, slots),
    level0: adj.level0.slice(0, slots * stride),
    upperBase: adj.upperBase.slice(0, slots),
    upper: adj.upper.slice(0, used),
    tombstones: state.tombstones.slice(0, slots),
    tombstoneCount: Atomics.load(state.header, GRAPH_TOMBSTONE_COUNT),
    nodeCount: Atomics.load(state.header, GRAPH_NODE_COUNT),
    entryPointOrd: Atomics.load(state.header, GRAPH_ENTRY_POINT),
    topLayer: Atomics.load(state.header, GRAPH_TOP_LAYER),
  }
}

/**
 * Copies a snapshot into the graph's buffers, which the caller must hold
 * exclusively.
 *
 * @param state The graph to fill.
 * @param snapshot The graph to copy in.
 *
 * @internal
 */
export function restoreSnapshot(state: HNSWGraphState, snapshot: HNSWSnapshot): void {
  resetGraph(state)
  const adj = state.adjacency
  ensureAdjacencyCapacity(adj, snapshot.slots)
  adj.nodeLevels.set(snapshot.nodeLevels)
  adj.level0.set(snapshot.level0)
  adj.upperBase.set(snapshot.upperBase)
  ensureUpperCapacity(adj, snapshot.upper.length)
  adj.upper.set(snapshot.upper)
  Atomics.store(state.header, GRAPH_UPPER_USED, snapshot.upperUsed)
  Atomics.store(state.header, GRAPH_SLOTS, snapshot.slots)
  state.tombstones = fixedView(adj.handles.tombstones, Uint8Array)
  state.tombstones.set(snapshot.tombstones)
  Atomics.store(state.header, GRAPH_TOMBSTONE_COUNT, snapshot.tombstoneCount)
  Atomics.store(state.header, GRAPH_NODE_COUNT, snapshot.nodeCount)
  Atomics.store(state.header, GRAPH_ENTRY_POINT, snapshot.entryPointOrd)
  Atomics.store(state.header, GRAPH_TOP_LAYER, snapshot.topLayer)
}
