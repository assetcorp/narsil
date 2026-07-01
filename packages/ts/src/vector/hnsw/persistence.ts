import { addConnection, ensureCapacity, type HNSWGraphState, type HNSWNode, type SerializedHNSWGraph } from './shared'

export function serializeGraph(state: HNSWGraphState): SerializedHNSWGraph {
  const nodeArray: Array<[string, number, Array<[number, string[]]>]> = []
  for (let ord = 0; ord < state.nodesByOrd.length; ord++) {
    const node = state.nodesByOrd[ord]
    if (!node) continue
    if (state.tombstones[ord] === 1) continue
    const docId = state.store.docIdForOrdinal(ord)
    if (docId === undefined) continue

    const layerConns: Array<[number, string[]]> = []
    for (let layer = 0; layer < node.connections.length; layer++) {
      const liveNeighbors: string[] = []
      for (const neighborOrd of node.connections[layer]) {
        if (state.tombstones[neighborOrd] === 1) continue
        const neighborDoc = state.store.docIdForOrdinal(neighborOrd)
        if (neighborDoc === undefined) continue
        liveNeighbors.push(neighborDoc)
      }
      if (liveNeighbors.length > 0) {
        layerConns.push([layer, liveNeighbors])
      }
    }
    nodeArray.push([docId, node.maxLayer, layerConns])
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

export function deserializeGraph(state: HNSWGraphState, data: SerializedHNSWGraph): void {
  state.nodesByOrd = []
  state.tombstones.fill(0)
  state.tombstoneCount = 0
  state.nodeCount = 0
  state.entryPointOrd = -1
  state.topLayer = -1

  let maxOrd = -1

  for (const [docId, maxLayer, layerConns] of data.nodes) {
    const ord = state.store.getOrdinal(docId)
    if (ord === undefined) continue
    if (state.store.entryForOrdinal(ord) === undefined) continue

    const connections: number[][] = Array.from({ length: maxLayer + 1 }, () => [] as number[])
    for (const [layer, neighbors] of layerConns) {
      if (layer < connections.length) {
        const arr: number[] = []
        for (const neighborDoc of neighbors) {
          const neighborOrd = state.store.getOrdinal(neighborDoc)
          if (neighborOrd === undefined) continue
          addConnection(arr, neighborOrd)
          if (neighborOrd > maxOrd) maxOrd = neighborOrd
        }
        connections[layer] = arr
      }
    }

    const node: HNSWNode = { maxLayer, connections }
    state.nodesByOrd[ord] = node
    state.nodeCount++
    if (ord > maxOrd) maxOrd = ord
  }

  if (maxOrd >= 0) {
    ensureCapacity(state, maxOrd + 1)
  }

  if (data.entryPoint != null && data.entryPoint !== '') {
    const epOrd = state.store.getOrdinal(data.entryPoint)
    if (epOrd !== undefined && state.nodesByOrd[epOrd] !== undefined) {
      state.entryPointOrd = epOrd
      state.topLayer = data.maxLayer
    }
  }

  if (state.entryPointOrd === -1 && state.nodeCount > 0) {
    let bestOrd = -1
    let bestLayer = -1
    for (let ord = 0; ord < state.nodesByOrd.length; ord++) {
      const n = state.nodesByOrd[ord]
      if (!n) continue
      if (n.maxLayer > bestLayer) {
        bestLayer = n.maxLayer
        bestOrd = ord
      }
    }
    state.entryPointOrd = bestOrd
    state.topLayer = bestLayer
  }
}
