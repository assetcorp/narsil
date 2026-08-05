import { collectNeighbors, createNode, MAX_LAYER_CAP, replaceNeighbors, resetAdjacency } from './adjacency'
import {
  addConnection,
  ensureCapacity,
  type HNSWGraphState,
  maxConns,
  nodeExists,
  nodeMaxLayer,
  type SerializedHNSWGraph,
} from './shared'

export function serializeGraph(state: HNSWGraphState): SerializedHNSWGraph {
  const nodeArray: Array<[string, number, Array<[number, string[]]>]> = []
  for (let ord = 0; ord < state.adjacency.slots; ord++) {
    const maxLayer = nodeMaxLayer(state, ord)
    if (maxLayer === -1) continue
    if (state.tombstones[ord] === 1) continue
    const docId = state.store.docIdForOrdinal(ord)
    if (docId === undefined) continue

    const layerConns: Array<[number, string[]]> = []
    for (let layer = 0; layer <= maxLayer; layer++) {
      const liveNeighbors: string[] = []
      for (const neighborOrd of collectNeighbors(state.adjacency, ord, layer)) {
        if (state.tombstones[neighborOrd] === 1) continue
        const neighborDoc = state.store.docIdForOrdinal(neighborOrd)
        if (neighborDoc === undefined) continue
        liveNeighbors.push(neighborDoc)
      }
      if (liveNeighbors.length > 0) {
        layerConns.push([layer, liveNeighbors])
      }
    }
    nodeArray.push([docId, maxLayer, layerConns])
  }

  const entryPoint = state.entryPointOrd === -1 ? null : (state.store.docIdForOrdinal(state.entryPointOrd) ?? null)

  return {
    entryPoint,
    maxLayer: state.topLayer,
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

function resolveNodes(state: HNSWGraphState, data: SerializedHNSWGraph): { nodes: ResolvedNode[]; maxOrd: number } {
  const nodes: ResolvedNode[] = []
  let maxOrd = -1

  for (const [docId, maxLayer, layerConns] of data.nodes) {
    const ord = state.store.getOrdinal(docId)
    if (ord === undefined) continue
    if (state.store.entryForOrdinal(ord) === undefined) continue

    const clampedMaxLayer = Math.min(Math.max(maxLayer, 0), MAX_LAYER_CAP)
    const layers: Array<[number, number[]]> = []

    for (const [layer, neighbors] of layerConns) {
      if (layer < 0 || layer > clampedMaxLayer) continue
      const limit = maxConns(state, layer)
      const resolved: number[] = []
      for (const neighborDoc of neighbors) {
        if (resolved.length >= limit) break
        const neighborOrd = state.store.getOrdinal(neighborDoc)
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

export function deserializeGraph(state: HNSWGraphState, data: SerializedHNSWGraph): void {
  resetAdjacency(state.adjacency)
  state.tombstones.fill(0)
  state.tombstoneCount = 0
  state.nodeCount = 0
  state.entryPointOrd = -1
  state.topLayer = -1

  const { nodes, maxOrd } = resolveNodes(state, data)

  if (maxOrd >= 0) {
    ensureCapacity(state, maxOrd + 1)
  }

  for (const node of nodes) {
    createNode(state.adjacency, node.ord, node.maxLayer)
    for (const [layer, neighbors] of node.layers) {
      replaceNeighbors(state.adjacency, node.ord, layer, neighbors)
    }
    state.nodeCount++
  }

  if (data.entryPoint != null && data.entryPoint !== '') {
    const epOrd = state.store.getOrdinal(data.entryPoint)
    if (epOrd !== undefined && nodeExists(state, epOrd)) {
      state.entryPointOrd = epOrd
      state.topLayer = Math.min(Math.max(data.maxLayer, 0), MAX_LAYER_CAP)
    }
  }

  if (state.entryPointOrd === -1 && state.nodeCount > 0) {
    let bestOrd = -1
    let bestLayer = -1
    for (let ord = 0; ord < state.adjacency.slots; ord++) {
      const level = nodeMaxLayer(state, ord)
      if (level === -1) continue
      if (level > bestLayer) {
        bestLayer = level
        bestOrd = ord
      }
    }
    state.entryPointOrd = bestOrd
    state.topLayer = bestLayer
  }
}
