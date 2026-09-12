import { fixedView } from '../shared-buffers/growable'
import {
  addNeighbor,
  adjacencySlots,
  collectNeighbors,
  createNode,
  deleteNode,
  neighborCount,
  removeNeighbor,
  replaceNeighbors,
  resetAdjacency,
} from './adjacency'
import { pruneConnections, searchLayer, selectNeighborsHeuristic } from './graph-ops'
import { GRAPH_ENTRY_POINT, GRAPH_NODE_COUNT, GRAPH_TOMBSTONE_COUNT, GRAPH_TOP_LAYER } from './handles'
import { lockEntry, lockGraphShared, lockNodeWrite, unlockEntry, unlockGraphShared, unlockNodeWrite } from './locks'
import {
  ensureCapacity,
  entryPointOf,
  type HNSWGraphState,
  isTombstoned,
  maxConns,
  nodeDistanceByOrd,
  nodeExists,
  nodeMaxLayer,
  randomLevel,
  reachTombstone,
  topLayerOf,
} from './shared'
import { appendToList, setEntryPointsFromList, setSingleEntryPoint } from './workspace'

function clearTombstone(state: HNSWGraphState, ord: number): void {
  if (reachTombstone(state, ord) && Atomics.compareExchange(state.tombstones, ord, 1, 0) === 1) {
    Atomics.sub(state.header, GRAPH_TOMBSTONE_COUNT, 1)
  }
}

function highestNode(state: HNSWGraphState, includeTombstoned: boolean): number {
  let bestOrd = -1
  let bestLayer = -1
  const slots = adjacencySlots(state.adjacency)
  for (let ord = 0; ord < slots; ord++) {
    const level = nodeMaxLayer(state, ord)
    if (level === -1) continue
    if (!includeTombstoned && isTombstoned(state, ord)) continue
    if (level > bestLayer) {
      bestLayer = level
      bestOrd = ord
    }
  }
  return bestOrd
}

function setEntryPoint(state: HNSWGraphState, ord: number): void {
  Atomics.store(state.header, GRAPH_ENTRY_POINT, ord)
  Atomics.store(state.header, GRAPH_TOP_LAYER, ord === -1 ? -1 : nodeMaxLayer(state, ord))
}

function claimEntryIfEmpty(state: HNSWGraphState, ord: number, level: number): boolean {
  lockEntry(state.locks)
  try {
    if (Atomics.load(state.header, GRAPH_ENTRY_POINT) !== -1) return false
    Atomics.store(state.header, GRAPH_ENTRY_POINT, ord)
    Atomics.store(state.header, GRAPH_TOP_LAYER, level)
    return true
  } finally {
    unlockEntry(state.locks)
  }
}

function raiseEntry(state: HNSWGraphState, ord: number, level: number): void {
  lockEntry(state.locks)
  try {
    if (level <= Atomics.load(state.header, GRAPH_TOP_LAYER)) return
    Atomics.store(state.header, GRAPH_ENTRY_POINT, ord)
    Atomics.store(state.header, GRAPH_TOP_LAYER, level)
  } finally {
    unlockEntry(state.locks)
  }
}

function linkNode(state: HNSWGraphState, ord: number, level: number): void {
  const metric = state.buildMetric
  const workspace = state.workspace
  const candidates = workspace.traversal
  const selected = workspace.insertSelection
  const entry = state.store.entryForOrdinal(ord)
  if (entry === undefined) return
  const insertDistFn = (candOrd: number) => nodeDistanceByOrd(state, ord, candOrd, metric)
  const entryPoint = entryPointOf(state)
  const topLayer = topLayerOf(state)
  setSingleEntryPoint(workspace, entryPoint)

  for (let layer = topLayer; layer > level; layer--) {
    searchLayer(state, entry.vector, entry.magnitude, 1, layer, metric, false, insertDistFn, candidates)
    if (candidates.size > 0) {
      setSingleEntryPoint(workspace, candidates.ords[0])
    }
  }

  for (let layer = Math.min(level, topLayer); layer >= 0; layer--) {
    searchLayer(state, entry.vector, entry.magnitude, state.efCons, layer, metric, false, insertDistFn, candidates)
    selectNeighborsHeuristic(state, candidates, maxConns(state, layer), metric, selected)

    lockNodeWrite(state.locks, ord)
    replaceNeighbors(state.adjacency, ord, layer, selected.ords, selected.size)
    unlockNodeWrite(state.locks, ord)

    for (let i = 0; i < selected.size; i++) {
      const neighborOrd = selected.ords[i]
      if (layer > nodeMaxLayer(state, neighborOrd)) continue
      lockNodeWrite(state.locks, neighborOrd)
      try {
        addNeighbor(state.adjacency, neighborOrd, layer, ord)
        pruneConnections(state, neighborOrd, layer, metric)
      } finally {
        unlockNodeWrite(state.locks, neighborOrd)
      }
    }

    if (candidates.size > 0) {
      setEntryPointsFromList(workspace, candidates)
    }
  }

  if (level > topLayer) raiseEntry(state, ord, level)
}

/**
 * Places the vector at an ordinal in the graph, sharing the graph with every
 * other thread placing or searching at the same time.
 *
 * @param state This thread's graph state.
 * @param ord The ordinal to place.
 * @param holdsGraphLock True where the caller already holds the graph lock.
 * @returns True where the node went in, and false where the graph held it
 * already or the store retired the ordinal while the batch was in flight.
 *
 * @internal
 */
export function insertNode(state: HNSWGraphState, ord: number, holdsGraphLock = false): boolean {
  if (!state.store.holdsOrdinal(ord)) return false
  ensureCapacity(state, ord + 1)
  if (nodeExists(state, ord)) return false

  if (!holdsGraphLock) lockGraphShared(state.locks)
  try {
    clearTombstone(state, ord)
    const level = randomLevel(state.mL)
    createNode(state.adjacency, ord, level)
    Atomics.add(state.header, GRAPH_NODE_COUNT, 1)
    if (claimEntryIfEmpty(state, ord, level)) return true
    linkNode(state, ord, level)
  } finally {
    if (!holdsGraphLock) unlockGraphShared(state.locks)
  }
  return true
}

/**
 * Cuts a node out of the graph and repairs its neighbours' lists. The caller
 * must hold the graph exclusively.
 *
 * @internal
 */
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
  Atomics.sub(state.header, GRAPH_NODE_COUNT, 1)
  clearTombstone(state, ord)

  if (entryPointOf(state) === ord) {
    if (Atomics.load(state.header, GRAPH_NODE_COUNT) === 0) {
      setEntryPoint(state, -1)
      return
    }
    const live = highestNode(state, false)
    setEntryPoint(state, live === -1 ? highestNode(state, true) : live)
  }
}

/**
 * Marks a node removed, keeping it in the graph as a stepping stone until
 * compaction cuts it out.
 *
 * @internal
 */
export function markTombstone(state: HNSWGraphState, ord: number): void {
  if (!nodeExists(state, ord) || !reachTombstone(state, ord)) return
  if (Atomics.compareExchange(state.tombstones, ord, 0, 1) === 0) {
    Atomics.add(state.header, GRAPH_TOMBSTONE_COUNT, 1)
  }
  if (entryPointOf(state) !== ord) return
  lockEntry(state.locks)
  try {
    if (entryPointOf(state) === ord) setEntryPoint(state, highestNode(state, false))
  } finally {
    unlockEntry(state.locks)
  }
}

/**
 * Cuts every tombstoned node out of the graph. The caller must hold the graph
 * exclusively.
 *
 * @internal
 */
export function compactTombstones(state: HNSWGraphState): void {
  if (Atomics.load(state.header, GRAPH_TOMBSTONE_COUNT) === 0) return

  const tombstonedOrds: number[] = []
  const slots = adjacencySlots(state.adjacency)
  for (let ord = 0; ord < slots; ord++) {
    if (isTombstoned(state, ord) && nodeExists(state, ord)) {
      tombstonedOrds.push(ord)
    }
  }

  const excl = new Set<number>(tombstonedOrds)
  for (const ord of tombstonedOrds) {
    removeNodeEager(state, ord, excl)
  }
}

/**
 * Empties the graph in place. The caller must hold the graph exclusively.
 *
 * @internal
 */
export function resetGraph(state: HNSWGraphState): void {
  resetAdjacency(state.adjacency)
  state.tombstones = fixedView(state.adjacency.handles.tombstones, Uint8Array)
  state.tombstones.fill(0)
  Atomics.store(state.header, GRAPH_TOMBSTONE_COUNT, 0)
  Atomics.store(state.header, GRAPH_NODE_COUNT, 0)
  Atomics.store(state.header, GRAPH_ENTRY_POINT, -1)
  Atomics.store(state.header, GRAPH_TOP_LAYER, -1)
}

/**
 * Rebuilds the graph in place from its live nodes. The caller must hold the
 * graph exclusively.
 *
 * @internal
 */
export function rebuild(state: HNSWGraphState): void {
  const nodeCount = Atomics.load(state.header, GRAPH_NODE_COUNT)
  if (Atomics.load(state.header, GRAPH_TOMBSTONE_COUNT) === 0 && nodeCount === 0) return

  const liveOrds: number[] = []
  const slots = adjacencySlots(state.adjacency)
  for (let ord = 0; ord < slots; ord++) {
    if (nodeExists(state, ord) && !isTombstoned(state, ord)) {
      liveOrds.push(ord)
    }
  }

  resetGraph(state)

  for (const ord of liveOrds) {
    if (!state.store.holdsOrdinal(ord)) continue
    insertNode(state, ord, true)
  }
}
