import { nearestFromHeap, pruneConnections, searchLayer, selectNeighborsHeuristic } from './graph-ops'
import { type DistancePair, type HNSWGraphState, type HNSWNode, maxConns, nodeDistance, randomLevel } from './shared'

export function insertNode(state: HNSWGraphState, docId: string): void {
  const vecEntry = state.store.get(docId)
  if (!vecEntry) {
    throw new Error(`Cannot insert HNSW node: vector for "${docId}" not found in VectorStore`)
  }

  if (vecEntry.vector.length !== state.dimension) {
    throw new Error(`Vector dimension mismatch: expected ${state.dimension}, got ${vecEntry.vector.length}`)
  }

  if (state.nodes.has(docId)) {
    removeNodeEager(state, docId)
  }

  state.tombstones.delete(docId)
  const l = randomLevel(state.mL)

  const node: HNSWNode = {
    docId,
    maxLayer: l,
    connections: Array.from({ length: l + 1 }, () => new Set<string>()),
  }

  state.nodes.set(docId, node)

  if (state.entryPointId === null) {
    state.entryPointId = docId
    state.topLayer = l
    return
  }

  const metric = state.buildMetric
  let currentEPs = [state.entryPointId]

  for (let layer = state.topLayer; layer > l; layer--) {
    const heap = searchLayer(state, vecEntry.vector, vecEntry.magnitude, currentEPs, 1, layer, metric, false)
    const nearest = nearestFromHeap(heap)
    if (nearest) {
      currentEPs = [nearest.docId]
    }
  }

  for (let layer = Math.min(l, state.topLayer); layer >= 0; layer--) {
    const heap = searchLayer(state, vecEntry.vector, vecEntry.magnitude, currentEPs, state.efCons, layer, metric, false)
    const candidates = heap.toSortedArray().reverse()
    const mc = maxConns(state, layer)
    const neighbors = selectNeighborsHeuristic(state, docId, candidates, mc, layer, metric, false, true)

    for (const neighbor of neighbors) {
      node.connections[layer].add(neighbor.docId)
      const neighborNode = state.nodes.get(neighbor.docId)
      if (neighborNode && layer < neighborNode.connections.length) {
        neighborNode.connections[layer].add(docId)
        pruneConnections(state, neighbor.docId, layer, metric)
      }
    }

    if (candidates.length > 0) {
      currentEPs = candidates.map(n => n.docId)
    }
  }

  if (l > state.topLayer) {
    state.entryPointId = docId
    state.topLayer = l
  }
}

export function removeNodeEager(state: HNSWGraphState, docId: string, excludeDocIds?: Set<string>): void {
  const node = state.nodes.get(docId)
  if (!node) return

  const metric = state.buildMetric

  for (let layer = 0; layer <= node.maxLayer; layer++) {
    if (layer >= node.connections.length) continue
    const formerNeighborIds = new Set(node.connections[layer])

    for (const neighborId of formerNeighborIds) {
      const neighborNode = state.nodes.get(neighborId)
      if (neighborNode && layer < neighborNode.connections.length) {
        neighborNode.connections[layer].delete(docId)
      }
    }

    for (const neighborId of formerNeighborIds) {
      const neighborNode = state.nodes.get(neighborId)
      if (!neighborNode || layer >= neighborNode.connections.length) continue

      const mc = maxConns(state, layer)
      if (neighborNode.connections[layer].size >= mc) continue

      const candidateIds = new Set(neighborNode.connections[layer])
      for (const otherId of formerNeighborIds) {
        if (otherId !== neighborId && otherId !== docId) {
          if (excludeDocIds?.has(otherId)) continue
          candidateIds.add(otherId)
        }
      }

      const candidates: DistancePair[] = []
      for (const candId of candidateIds) {
        const dist = nodeDistance(state, neighborId, candId, metric)
        if (dist === Number.POSITIVE_INFINITY) continue
        candidates.push({ docId: candId, distance: dist })
      }

      const selected = selectNeighborsHeuristic(state, neighborId, candidates, mc, layer, metric, false, true)
      const newConns = new Set(selected.map(s => s.docId))
      neighborNode.connections[layer] = newConns

      for (const newConnId of newConns) {
        const newConnNode = state.nodes.get(newConnId)
        if (newConnNode && layer < newConnNode.connections.length) {
          newConnNode.connections[layer].add(neighborId)
          pruneConnections(state, newConnId, layer, metric)
        }
      }
    }
  }

  state.nodes.delete(docId)

  if (state.entryPointId === docId) {
    if (state.nodes.size === 0) {
      state.entryPointId = null
      state.topLayer = -1
      return
    }
    let newEntryId: string | null = null
    let newTopLayer = -1
    for (const [nId, n] of state.nodes) {
      if (state.tombstones.has(nId)) continue
      if (n.maxLayer > newTopLayer) {
        newTopLayer = n.maxLayer
        newEntryId = nId
      }
    }
    if (newEntryId === null) {
      for (const [nId, n] of state.nodes) {
        if (n.maxLayer > newTopLayer) {
          newTopLayer = n.maxLayer
          newEntryId = nId
        }
      }
    }
    state.entryPointId = newEntryId
    state.topLayer = newTopLayer
  }
}

export function markTombstone(state: HNSWGraphState, docId: string): void {
  if (!state.nodes.has(docId)) return
  state.tombstones.add(docId)

  if (state.entryPointId === docId) {
    let newEntryId: string | null = null
    let newTopLayer = -1
    for (const [nId, n] of state.nodes) {
      if (state.tombstones.has(nId)) continue
      if (n.maxLayer > newTopLayer) {
        newTopLayer = n.maxLayer
        newEntryId = nId
      }
    }
    if (newEntryId !== null) {
      state.entryPointId = newEntryId
      state.topLayer = newTopLayer
    } else {
      state.entryPointId = null
      state.topLayer = -1
    }
  }
}

export function compactTombstones(state: HNSWGraphState): void {
  if (state.tombstones.size === 0) return

  const tombstonedDocIds = Array.from(state.tombstones)

  for (const docId of tombstonedDocIds) {
    removeNodeEager(state, docId, state.tombstones)
  }

  state.tombstones.clear()
}

export function rebuild(state: HNSWGraphState): void {
  if (state.tombstones.size === 0 && state.nodes.size === 0) return

  const liveDocIds: string[] = []
  for (const [docId] of state.nodes) {
    if (!state.tombstones.has(docId)) {
      liveDocIds.push(docId)
    }
  }

  state.nodes.clear()
  state.tombstones.clear()
  state.entryPointId = null
  state.topLayer = -1

  for (const docId of liveDocIds) {
    const entry = state.store.get(docId)
    if (!entry) continue
    insertNode(state, docId)
  }
}
