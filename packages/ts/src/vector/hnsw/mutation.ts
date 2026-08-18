import {
  addNeighbor,
  collectNeighbors,
  createNode,
  deleteNode,
  neighborCount,
  removeNeighbor,
  replaceNeighbors,
  resetAdjacency,
} from './adjacency'
import { nearestFromHeap, pruneConnections, searchLayer, selectNeighborsHeuristic } from './graph-ops'
import {
  addConnection,
  type DistancePair,
  ensureCapacity,
  type HNSWGraphState,
  maxConns,
  nodeDistanceByOrd,
  nodeExists,
  nodeMaxLayer,
  randomLevel,
} from './shared'

function clearTombstone(state: HNSWGraphState, ord: number): void {
  if (state.tombstones[ord] === 1) {
    state.tombstones[ord] = 0
    state.tombstoneCount--
  }
}

function reassignEntryPoint(state: HNSWGraphState): void {
  let bestOrd = -1
  let bestLayer = -1
  for (let ord = 0; ord < state.adjacency.slots; ord++) {
    const level = nodeMaxLayer(state, ord)
    if (level === -1) continue
    if (state.tombstones[ord] === 1) continue
    if (level > bestLayer) {
      bestLayer = level
      bestOrd = ord
    }
  }
  if (bestOrd === -1) {
    for (let ord = 0; ord < state.adjacency.slots; ord++) {
      const level = nodeMaxLayer(state, ord)
      if (level === -1) continue
      if (level > bestLayer) {
        bestLayer = level
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

  if (nodeExists(state, ord)) {
    removeNodeEager(state, ord)
  }

  clearTombstone(state, ord)
  const l = randomLevel(state.mL)

  createNode(state.adjacency, ord, l)
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
      addNeighbor(state.adjacency, ord, layer, neighbor.ord)
      if (layer <= nodeMaxLayer(state, neighbor.ord)) {
        addNeighbor(state.adjacency, neighbor.ord, layer, ord)
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
  const maxLayer = nodeMaxLayer(state, ord)
  if (maxLayer === -1) return

  const metric = state.buildMetric

  for (let layer = 0; layer <= maxLayer; layer++) {
    const formerNeighbors = collectNeighbors(state.adjacency, ord, layer)

    for (const neighborOrd of formerNeighbors) {
      if (layer <= nodeMaxLayer(state, neighborOrd)) {
        removeNeighbor(state.adjacency, neighborOrd, layer, ord)
      }
    }

    for (const neighborOrd of formerNeighbors) {
      if (layer > nodeMaxLayer(state, neighborOrd)) continue

      const mc = maxConns(state, layer)
      if (neighborCount(state.adjacency, neighborOrd, layer) >= mc) continue

      const candidateOrds = new Set<number>(collectNeighbors(state.adjacency, neighborOrd, layer))
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
      replaceNeighbors(state.adjacency, neighborOrd, layer, newConns)

      for (const newConnOrd of newConns) {
        if (layer <= nodeMaxLayer(state, newConnOrd)) {
          addNeighbor(state.adjacency, newConnOrd, layer, neighborOrd)
          pruneConnections(state, newConnOrd, layer, metric)
        }
      }
    }
  }

  deleteNode(state.adjacency, ord)
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
  if (ord === undefined || !nodeExists(state, ord)) return

  if (state.tombstones[ord] === 0) {
    state.tombstones[ord] = 1
    state.tombstoneCount++
  }

  if (state.entryPointOrd === ord) {
    let bestOrd = -1
    let bestLayer = -1
    for (let o = 0; o < state.adjacency.slots; o++) {
      const level = nodeMaxLayer(state, o)
      if (level === -1) continue
      if (state.tombstones[o] === 1) continue
      if (level > bestLayer) {
        bestLayer = level
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
  for (let ord = 0; ord < state.adjacency.slots; ord++) {
    if (state.tombstones[ord] === 1 && nodeExists(state, ord)) {
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
  for (let ord = 0; ord < state.adjacency.slots; ord++) {
    if (nodeExists(state, ord) && state.tombstones[ord] !== 1) {
      liveOrds.push(ord)
    }
  }

  resetAdjacency(state.adjacency)
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
