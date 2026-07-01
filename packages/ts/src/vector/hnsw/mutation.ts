import { nearestFromHeap, pruneConnections, searchLayer, selectNeighborsHeuristic } from './graph-ops'
import {
  addConnection,
  type DistancePair,
  ensureCapacity,
  type HNSWGraphState,
  type HNSWNode,
  maxConns,
  nodeDistanceByOrd,
  randomLevel,
} from './shared'

function removeFromArray(arr: number[], ord: number): void {
  const idx = arr.indexOf(ord)
  if (idx !== -1) arr.splice(idx, 1)
}

function clearTombstone(state: HNSWGraphState, ord: number): void {
  if (state.tombstones[ord] === 1) {
    state.tombstones[ord] = 0
    state.tombstoneCount--
  }
}

function reassignEntryPoint(state: HNSWGraphState): void {
  let bestOrd = -1
  let bestLayer = -1
  for (let ord = 0; ord < state.nodesByOrd.length; ord++) {
    const n = state.nodesByOrd[ord]
    if (!n) continue
    if (state.tombstones[ord] === 1) continue
    if (n.maxLayer > bestLayer) {
      bestLayer = n.maxLayer
      bestOrd = ord
    }
  }
  if (bestOrd === -1) {
    for (let ord = 0; ord < state.nodesByOrd.length; ord++) {
      const n = state.nodesByOrd[ord]
      if (!n) continue
      if (n.maxLayer > bestLayer) {
        bestLayer = n.maxLayer
        bestOrd = ord
      }
    }
  }
  state.entryPointOrd = bestOrd
  state.topLayer = bestOrd === -1 ? -1 : bestLayer
}

export function insertNode(state: HNSWGraphState, docId: string): void {
  const ord = state.store.getOrdinal(docId)
  if (ord === undefined) {
    throw new Error(`Cannot insert HNSW node: vector for "${docId}" not found in VectorStore`)
  }
  const entry = state.store.entryForOrdinal(ord)
  if (!entry) {
    throw new Error(`Cannot insert HNSW node: vector for "${docId}" not found in VectorStore`)
  }
  if (entry.vector.length !== state.dimension) {
    throw new Error(`Vector dimension mismatch: expected ${state.dimension}, got ${entry.vector.length}`)
  }

  ensureCapacity(state, ord + 1)

  if (state.nodesByOrd[ord] !== undefined) {
    removeNodeEager(state, ord)
  }

  clearTombstone(state, ord)
  const l = randomLevel(state.mL)

  const node: HNSWNode = {
    maxLayer: l,
    connections: Array.from({ length: l + 1 }, () => [] as number[]),
  }

  state.nodesByOrd[ord] = node
  state.nodeCount++

  if (state.entryPointOrd === -1) {
    state.entryPointOrd = ord
    state.topLayer = l
    return
  }

  const metric = state.buildMetric
  const insertDistFn = (candOrd: number) => nodeDistanceByOrd(state, ord, candOrd, metric)
  let currentEPs = [state.entryPointOrd]

  for (let layer = state.topLayer; layer > l; layer--) {
    const heap = searchLayer(state, entry.vector, entry.magnitude, currentEPs, 1, layer, metric, false, insertDistFn)
    const nearest = nearestFromHeap(heap)
    if (nearest) {
      currentEPs = [nearest.ord]
    }
  }

  for (let layer = Math.min(l, state.topLayer); layer >= 0; layer--) {
    const heap = searchLayer(
      state,
      entry.vector,
      entry.magnitude,
      currentEPs,
      state.efCons,
      layer,
      metric,
      false,
      insertDistFn,
    )
    const candidates = heap.toSortedArray().reverse()
    const mc = maxConns(state, layer)
    const neighbors = selectNeighborsHeuristic(state, ord, candidates, mc, layer, metric, false, true)

    for (const neighbor of neighbors) {
      addConnection(node.connections[layer], neighbor.ord)
      const neighborNode = state.nodesByOrd[neighbor.ord]
      if (neighborNode && layer < neighborNode.connections.length) {
        addConnection(neighborNode.connections[layer], ord)
        pruneConnections(state, neighbor.ord, layer, metric)
      }
    }

    if (candidates.length > 0) {
      currentEPs = candidates.map(n => n.ord)
    }
  }

  if (l > state.topLayer) {
    state.entryPointOrd = ord
    state.topLayer = l
  }
}

export function removeNodeEager(state: HNSWGraphState, ord: number, excludeOrds?: Set<number>): void {
  const node = state.nodesByOrd[ord]
  if (!node) return

  const metric = state.buildMetric

  for (let layer = 0; layer <= node.maxLayer; layer++) {
    if (layer >= node.connections.length) continue
    const formerNeighbors = [...node.connections[layer]]

    for (const neighborOrd of formerNeighbors) {
      const neighborNode = state.nodesByOrd[neighborOrd]
      if (neighborNode && layer < neighborNode.connections.length) {
        removeFromArray(neighborNode.connections[layer], ord)
      }
    }

    for (const neighborOrd of formerNeighbors) {
      const neighborNode = state.nodesByOrd[neighborOrd]
      if (!neighborNode || layer >= neighborNode.connections.length) continue

      const mc = maxConns(state, layer)
      if (neighborNode.connections[layer].length >= mc) continue

      const candidateOrds = new Set<number>(neighborNode.connections[layer])
      for (const otherOrd of formerNeighbors) {
        if (otherOrd !== neighborOrd && otherOrd !== ord) {
          if (excludeOrds?.has(otherOrd)) continue
          candidateOrds.add(otherOrd)
        }
      }

      const candidates: DistancePair[] = []
      for (const candOrd of candidateOrds) {
        const dist = nodeDistanceByOrd(state, neighborOrd, candOrd, metric)
        if (dist === Number.POSITIVE_INFINITY) continue
        candidates.push({ ord: candOrd, distance: dist })
      }

      const selected = selectNeighborsHeuristic(state, neighborOrd, candidates, mc, layer, metric, false, true)
      const newConns: number[] = []
      for (const s of selected) addConnection(newConns, s.ord)
      neighborNode.connections[layer] = newConns

      for (const newConnOrd of newConns) {
        const newConnNode = state.nodesByOrd[newConnOrd]
        if (newConnNode && layer < newConnNode.connections.length) {
          addConnection(newConnNode.connections[layer], neighborOrd)
          pruneConnections(state, newConnOrd, layer, metric)
        }
      }
    }
  }

  state.nodesByOrd[ord] = undefined
  state.nodeCount--
  clearTombstone(state, ord)

  if (state.entryPointOrd === ord) {
    if (state.nodeCount === 0) {
      state.entryPointOrd = -1
      state.topLayer = -1
      return
    }
    reassignEntryPoint(state)
  }
}

export function markTombstone(state: HNSWGraphState, docId: string): void {
  const ord = state.store.getOrdinal(docId)
  if (ord === undefined || state.nodesByOrd[ord] === undefined) return

  if (state.tombstones[ord] === 0) {
    state.tombstones[ord] = 1
    state.tombstoneCount++
  }

  if (state.entryPointOrd === ord) {
    let bestOrd = -1
    let bestLayer = -1
    for (let o = 0; o < state.nodesByOrd.length; o++) {
      const n = state.nodesByOrd[o]
      if (!n) continue
      if (state.tombstones[o] === 1) continue
      if (n.maxLayer > bestLayer) {
        bestLayer = n.maxLayer
        bestOrd = o
      }
    }
    if (bestOrd !== -1) {
      state.entryPointOrd = bestOrd
      state.topLayer = bestLayer
    } else {
      state.entryPointOrd = -1
      state.topLayer = -1
    }
  }
}

export function compactTombstones(state: HNSWGraphState): void {
  if (state.tombstoneCount === 0) return

  const tombstonedOrds: number[] = []
  for (let ord = 0; ord < state.nodesByOrd.length; ord++) {
    if (state.tombstones[ord] === 1 && state.nodesByOrd[ord] !== undefined) {
      tombstonedOrds.push(ord)
    }
  }

  const excl = new Set<number>(tombstonedOrds)
  for (const ord of tombstonedOrds) {
    removeNodeEager(state, ord, excl)
  }
}

export function rebuild(state: HNSWGraphState): void {
  if (state.tombstoneCount === 0 && state.nodeCount === 0) return

  const liveOrds: number[] = []
  for (let ord = 0; ord < state.nodesByOrd.length; ord++) {
    if (state.nodesByOrd[ord] !== undefined && state.tombstones[ord] !== 1) {
      liveOrds.push(ord)
    }
  }

  state.nodesByOrd = []
  state.tombstones.fill(0)
  state.tombstoneCount = 0
  state.nodeCount = 0
  state.entryPointOrd = -1
  state.topLayer = -1

  for (const ord of liveOrds) {
    const docId = state.store.docIdForOrdinal(ord)
    if (docId === undefined) continue
    if (state.store.entryForOrdinal(ord) === undefined) continue
    insertNode(state, docId)
  }
}
