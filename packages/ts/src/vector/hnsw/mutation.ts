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
import { pruneConnections, searchLayer, selectNeighborsHeuristic } from './graph-ops'
import {
  ensureCapacity,
  type HNSWGraphState,
  maxConns,
  nodeDistanceByOrd,
  nodeExists,
  nodeMaxLayer,
  randomLevel,
} from './shared'
import { appendToList, setEntryPointsFromList, setSingleEntryPoint } from './workspace'

function clearTombstone(state: HNSWGraphState, ord: number): void {
  if (state.tombstones[ord] === 1) {
    state.tombstones[ord] = 0
    state.tombstoneCount--
  }
}

function highestNode(state: HNSWGraphState, includeTombstoned: boolean): number {
  let bestOrd = -1
  let bestLayer = -1
  for (let ord = 0; ord < state.adjacency.slots; ord++) {
    const level = nodeMaxLayer(state, ord)
    if (level === -1) continue
    if (!includeTombstoned && state.tombstones[ord] === 1) continue
    if (level > bestLayer) {
      bestLayer = level
      bestOrd = ord
    }
  }
  return bestOrd
}

function setEntryPoint(state: HNSWGraphState, ord: number): void {
  state.entryPointOrd = ord
  state.topLayer = ord === -1 ? -1 : nodeMaxLayer(state, ord)
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
  const workspace = state.workspace
  const candidates = workspace.traversal
  const selected = workspace.insertSelection
  const insertDistFn = (candOrd: number) => nodeDistanceByOrd(state, ord, candOrd, metric)
  setSingleEntryPoint(workspace, state.entryPointOrd)

  for (let layer = state.topLayer; layer > l; layer--) {
    searchLayer(state, entry.vector, entry.magnitude, 1, layer, metric, false, insertDistFn, candidates)
    if (candidates.size > 0) {
      setSingleEntryPoint(workspace, candidates.ords[0])
    }
  }

  for (let layer = Math.min(l, state.topLayer); layer >= 0; layer--) {
    searchLayer(state, entry.vector, entry.magnitude, state.efCons, layer, metric, false, insertDistFn, candidates)
    selectNeighborsHeuristic(state, candidates, maxConns(state, layer), metric, selected)

    for (let i = 0; i < selected.size; i++) {
      const neighborOrd = selected.ords[i]
      addNeighbor(state.adjacency, ord, layer, neighborOrd)
      if (layer <= nodeMaxLayer(state, neighborOrd)) {
        addNeighbor(state.adjacency, neighborOrd, layer, ord)
        pruneConnections(state, neighborOrd, layer, metric)
      }
    }

    if (candidates.size > 0) {
      setEntryPointsFromList(workspace, candidates)
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

      const candidates = state.workspace.repairCandidates
      candidates.size = 0
      for (const candOrd of candidateOrds) {
        const dist = nodeDistanceByOrd(state, neighborOrd, candOrd, metric)
        if (dist === Number.POSITIVE_INFINITY) continue
        appendToList(candidates, candOrd, dist)
      }

      const selected = state.workspace.repairSelection
      selectNeighborsHeuristic(state, candidates, mc, metric, selected)
      replaceNeighbors(state.adjacency, neighborOrd, layer, selected.ords, selected.size)

      for (let i = 0; i < selected.size; i++) {
        const newConnOrd = selected.ords[i]
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
      setEntryPoint(state, -1)
      return
    }
    const live = highestNode(state, false)
    setEntryPoint(state, live === -1 ? highestNode(state, true) : live)
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
    setEntryPoint(state, highestNode(state, false))
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
