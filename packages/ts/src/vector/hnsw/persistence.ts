import type { HNSWGraphState, HNSWNode, SerializedHNSWGraph } from './shared'

export function serializeGraph(state: HNSWGraphState): SerializedHNSWGraph {
  const nodeArray: Array<[string, number, Array<[number, string[]]>]> = []
  for (const [docId, node] of state.nodes) {
    if (state.tombstones.has(docId)) continue
    const layerConns: Array<[number, string[]]> = []
    for (let layer = 0; layer < node.connections.length; layer++) {
      const liveNeighbors = Array.from(node.connections[layer]).filter(id => !state.tombstones.has(id))
      if (liveNeighbors.length > 0) {
        layerConns.push([layer, liveNeighbors])
      }
    }
    nodeArray.push([docId, node.maxLayer, layerConns])
  }
  return {
    entryPoint: state.entryPointId,
    maxLayer: state.topLayer,
    m: state.M,
    efConstruction: state.efCons,
    metric: state.buildMetric,
    nodes: nodeArray,
  }
}

export function deserializeGraph(state: HNSWGraphState, data: SerializedHNSWGraph): void {
  state.nodes.clear()
  state.tombstones.clear()

  for (const [docId, maxLayer, layerConns] of data.nodes) {
    const vecData = state.store.get(docId)
    if (!vecData) continue

    const connections: Set<string>[] = Array.from({ length: maxLayer + 1 }, () => new Set<string>())
    for (const [layer, neighbors] of layerConns) {
      if (layer < connections.length) {
        connections[layer] = new Set(neighbors)
      }
    }

    const node: HNSWNode = { docId, maxLayer, connections }
    state.nodes.set(docId, node)
  }

  if (data.entryPoint != null && data.entryPoint !== '' && state.nodes.has(data.entryPoint)) {
    state.entryPointId = data.entryPoint
    state.topLayer = data.maxLayer
  } else if (state.nodes.size > 0) {
    let bestId: string | null = null
    let bestLayer = -1
    for (const [nId, n] of state.nodes) {
      if (n.maxLayer > bestLayer) {
        bestLayer = n.maxLayer
        bestId = nId
      }
    }
    state.entryPointId = bestId
    state.topLayer = bestLayer
  } else {
    state.entryPointId = null
    state.topLayer = -1
  }
}
