import type { VectorStore } from '../vector-store'
import { adjacencySlots, collectNeighbors, createNode, replaceNeighbors } from './adjacency'
import { MAX_LAYER_CAP } from './constants'
import { GRAPH_ENTRY_POINT, GRAPH_NODE_COUNT, GRAPH_TOP_LAYER } from './handles'
import { resetGraph } from './mutation'
import {
  addConnection,
  ensureCapacity,
  entryPointOf,
  type HNSWGraphState,
  isTombstoned,
  maxConns,
  nodeExists,
  nodeMaxLayer,
  type SerializedHNSWGraph,
  topLayerOf,
} from './shared'

/**
 * Copies a graph into the form the engine writes to disk, naming each node by
 * its document id and leaving every tombstoned node out.
 *
 * @param state The graph to copy.
 * @param store The store holding the field's vectors and ids.
 * @returns The serialised graph.
 *
 * @internal
 */
export function serializeGraph(state: HNSWGraphState, store: VectorStore): SerializedHNSWGraph {
  const nodeArray: Array<[string, number, Array<[number, string[]]>]> = []
  const slots = adjacencySlots(state.adjacency)
  for (let ord = 0; ord < slots; ord++) {
    const maxLayer = nodeMaxLayer(state, ord)
    if (maxLayer === -1) continue
    if (isTombstoned(state, ord)) continue
    const docId = store.docIdForOrdinal(ord)
    if (docId === undefined) continue

    const layerConns: Array<[number, string[]]> = []
    for (let layer = 0; layer <= maxLayer; layer++) {
      const liveNeighbors: string[] = []
      for (const neighborOrd of collectNeighbors(state.adjacency, ord, layer)) {
        if (isTombstoned(state, neighborOrd)) continue
        const neighborDoc = store.docIdForOrdinal(neighborOrd)
        if (neighborDoc === undefined) continue
        liveNeighbors.push(neighborDoc)
      }
      if (liveNeighbors.length > 0) {
        layerConns.push([layer, liveNeighbors])
      }
    }
    nodeArray.push([docId, maxLayer, layerConns])
  }

  const entryOrd = entryPointOf(state)
  const entryPoint = entryOrd === -1 ? null : (store.docIdForOrdinal(entryOrd) ?? null)

  return {
    entryPoint,
    maxLayer: topLayerOf(state),
    m: state.M,
    efConstruction: state.efCons,
    metric: state.buildMetric,
    nodes: nodeArray,
  }
}

interface ResolvedNode {
  ord: number
  maxLayer: number
  layers: Array<[number, number[]]>
}

function resolveNodes(
  state: HNSWGraphState,
  store: VectorStore,
  data: SerializedHNSWGraph,
): { nodes: ResolvedNode[]; maxOrd: number } {
  const nodes: ResolvedNode[] = []
  let maxOrd = -1

  for (const [docId, maxLayer, layerConns] of data.nodes) {
    const ord = store.getOrdinal(docId)
    if (ord === undefined) continue
    if (store.entryForOrdinal(ord) === undefined) continue

    const clampedMaxLayer = Math.min(Math.max(maxLayer, 0), MAX_LAYER_CAP)
    const layers: Array<[number, number[]]> = []

    for (const [layer, neighbors] of layerConns) {
      if (layer < 0 || layer > clampedMaxLayer) continue
      const limit = maxConns(state, layer)
      const resolved: number[] = []
      for (const neighborDoc of neighbors) {
        if (resolved.length >= limit) break
        const neighborOrd = store.getOrdinal(neighborDoc)
        if (neighborOrd === undefined) continue
        addConnection(resolved, neighborOrd)
        if (neighborOrd > maxOrd) maxOrd = neighborOrd
      }
      layers.push([layer, resolved])
    }

    if (ord > maxOrd) maxOrd = ord
    nodes.push({ ord, maxLayer: clampedMaxLayer, layers })
  }

  return { nodes, maxOrd }
}

/**
 * Restores a graph from its serialised form. The caller must hold the graph
 * exclusively.
 *
 * @param state The graph to fill.
 * @param store The store holding the field's vectors and ids.
 * @param data The serialised graph to read.
 *
 * @internal
 */
export function deserializeGraph(state: HNSWGraphState, store: VectorStore, data: SerializedHNSWGraph): void {
  resetGraph(state)

  const { nodes, maxOrd } = resolveNodes(state, store, data)

  if (maxOrd >= 0) {
    ensureCapacity(state, maxOrd + 1)
  }

  for (const node of nodes) {
    createNode(state.adjacency, node.ord, node.maxLayer)
    for (const [layer, neighbors] of node.layers) {
      replaceNeighbors(state.adjacency, node.ord, layer, neighbors, neighbors.length)
    }
    Atomics.add(state.header, GRAPH_NODE_COUNT, 1)
  }

  if (data.entryPoint != null && data.entryPoint !== '') {
    const epOrd = store.getOrdinal(data.entryPoint)
    if (epOrd !== undefined && nodeExists(state, epOrd)) {
      Atomics.store(state.header, GRAPH_ENTRY_POINT, epOrd)
      Atomics.store(state.header, GRAPH_TOP_LAYER, Math.min(Math.max(data.maxLayer, 0), MAX_LAYER_CAP))
    }
  }

  if (entryPointOf(state) === -1 && Atomics.load(state.header, GRAPH_NODE_COUNT) > 0) {
    let bestOrd = -1
    let bestLayer = -1
    const slots = adjacencySlots(state.adjacency)
    for (let ord = 0; ord < slots; ord++) {
      const level = nodeMaxLayer(state, ord)
      if (level === -1) continue
      if (level > bestLayer) {
        bestLayer = level
        bestOrd = ord
      }
    }
    Atomics.store(state.header, GRAPH_ENTRY_POINT, bestOrd)
    Atomics.store(state.header, GRAPH_TOP_LAYER, bestLayer)
  }
}
