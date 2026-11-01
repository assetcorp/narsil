import { noteFallback } from '../native/backend'
import { nativeFieldFor } from '../native/field'
import { nativeCompact, nativePlace, nativeRemove } from '../native/writes'
import { fixedView } from '../shared-buffers/growable'
import {
  addNeighbor,
  adjacencySlots,
  collectNeighbors,
  createNode,
  deleteNode,
  ensureUpperRoom,
  incomingCount,
  neighborCount,
  noteUnlinked,
  removeNeighbor,
  replaceNeighbors,
  resetAdjacency,
} from './adjacency'
import {
  baseNeighboursOfRemoved,
  connectAfterBuild,
  connectAfterPlacement,
  connectAfterRemoval,
  countIncomingBeforeWriting,
} from './connect-unreached'
import { PLACEMENT_ROOM_REQUESTS } from './constants'
import { pruneConnections, searchLayer, selectNeighborsHeuristic } from './graph-ops'
import {
  GRAPH_ENTRY_POINT,
  GRAPH_INCOMING_UNCOUNTED,
  GRAPH_NODE_COUNT,
  GRAPH_TOMBSTONE_COUNT,
  GRAPH_TOP_LAYER,
  publishGraphCapacity,
} from './handles'
import { shuffleInPlace } from './insertion-order'
import { isLive, noteNodeLeftUnlinked, writeKeepingLastLinks } from './last-links'
import { lockEntry, lockGraphShared, lockNodeWrite, unlockEntry, unlockGraphShared, unlockNodeWrite } from './locks'
import {
  buildsFromCodes,
  ensureCapacity,
  entryPointOf,
  type HNSWGraphState,
  isTombstoned,
  levelOfOrdinal,
  maxConns,
  nodeDistanceFunction,
  nodeExists,
  nodeMaxLayer,
  reachTombstone,
  topLayerOf,
} from './shared'
import { appendToList, linkSelectionsFor, setEntryPointsFromList, setSingleEntryPoint } from './workspace'

function clearTombstone(state: HNSWGraphState, ord: number): void {
  if (!reachTombstone(state, ord) || Atomics.load(state.tombstones, ord) !== 1) return
  Atomics.sub(state.header, GRAPH_TOMBSTONE_COUNT, 1)
  Atomics.store(state.tombstones, ord, 0)
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

function placementDistance(
  state: HNSWGraphState,
  vector: Float32Array,
  fullPrecision: (candOrd: number) => number,
): (candOrd: number) => number {
  const quantizer = state.quantizer
  if (quantizer === undefined || !buildsFromCodes(state)) return fullPrecision
  if (state.store.handles.vectorFiles.length > 0) return quantizer.placementDistance(vector) ?? fullPrecision
  const prepared = quantizer.prepareQuery(vector)
  return prepared === null ? fullPrecision : quantizer.preparedDistance(prepared)
}

function selectNeighborsPerLayer(state: HNSWGraphState, ord: number, level: number): number {
  const metric = state.buildMetric
  const workspace = state.workspace
  const candidates = workspace.traversal
  const entry = state.store.entryForOrdinal(ord)
  if (entry === undefined) return -1
  const fullPrecision = state.store.ordinalDistance(ord, metric)
  const insertDistFn = placementDistance(state, entry.vector, fullPrecision)
  const topLayer = topLayerOf(state)
  setSingleEntryPoint(workspace, entryPointOf(state))

  for (let layer = topLayer; layer > level; layer--) {
    searchLayer(state, entry.vector, entry.magnitude, 1, layer, metric, false, insertDistFn, candidates)
    if (candidates.size > 0) setSingleEntryPoint(workspace, candidates.ords[0])
  }

  const linkTop = Math.min(level, topLayer)
  const selections = linkSelectionsFor(workspace, linkTop + 1)
  const distance = nodeDistanceFunction(state, metric)
  for (let layer = linkTop; layer >= 0; layer--) {
    searchLayer(state, entry.vector, entry.magnitude, state.efCons, layer, metric, false, insertDistFn, candidates)
    selectNeighborsHeuristic(state, candidates, maxConns(state, layer), distance, selections[layer])
    if (candidates.size > 0) setEntryPointsFromList(workspace, candidates)
  }
  return linkTop
}

function writeOwnLists(state: HNSWGraphState, ord: number, linkTop: number): void {
  const selections = state.workspace.linkSelections
  lockNodeWrite(state.locks, ord)
  try {
    for (let layer = linkTop; layer >= 0; layer--) {
      const selected = selections[layer]
      replaceNeighbors(state.adjacency, ord, layer, selected.ords, selected.size)
    }
  } finally {
    unlockNodeWrite(state.locks, ord)
  }
}

function linkNeighborsBack(state: HNSWGraphState, ord: number, linkTop: number): void {
  const distance = nodeDistanceFunction(state, state.buildMetric)
  const selections = state.workspace.linkSelections
  for (let layer = linkTop; layer >= 0; layer--) {
    const selected = selections[layer]
    for (let i = 0; i < selected.size; i++) {
      const neighborOrd = selected.ords[i]
      if (layer > nodeMaxLayer(state, neighborOrd)) continue
      lockNodeWrite(state.locks, neighborOrd)
      try {
        addNeighbor(state.adjacency, neighborOrd, layer, ord)
        pruneConnections(state, neighborOrd, layer, distance)
      } finally {
        unlockNodeWrite(state.locks, neighborOrd)
      }
    }
  }
}

function linkNode(state: HNSWGraphState, ord: number, level: number): void {
  const topLayer = topLayerOf(state)
  const formerEntry = entryPointOf(state)
  const linkTop = selectNeighborsPerLayer(state, ord, level)
  if (linkTop < 0) return
  writeOwnLists(state, ord, linkTop)
  linkNeighborsBack(state, ord, linkTop)
  if (level <= topLayer) return
  raiseEntry(state, ord, level)
  const demoted = entryPointOf(state) !== formerEntry && isLive(state, formerEntry)
  if (demoted && incomingCount(state.adjacency, formerEntry) === 0) noteNodeLeftUnlinked(state)
}

function writeRecordBeforePlacement(state: HNSWGraphState, ord: number): void {
  const quantizer = state.quantizer
  if (quantizer === undefined || !buildsFromCodes(state)) return
  quantizer.writeCodes(ord)
}

function placeThroughTheCore(state: HNSWGraphState, ord: number, holdsGraphLock: boolean): boolean {
  let field = nativeFieldFor(state)
  if (field === null) return false
  const level = levelOfOrdinal(ord, state.mL)
  for (let request = 0; request < PLACEMENT_ROOM_REQUESTS && field !== null; request++) {
    ensureUpperRoom(state.adjacency, level)
    const placement = nativePlace(state, field, state.buildMetric, ord, level, holdsGraphLock)
    if (placement === 'placed') return true
    if (placement === 'failed') return false
    ensureCapacity(state, ord + 1)
    publishGraphCapacity(state.adjacency.handles)
    field = nativeFieldFor(state)
  }
  return false
}

export function insertNode(state: HNSWGraphState, ord: number, holdsGraphLock = false): boolean {
  if (!state.store.holdsOrdinal(ord)) return false
  ensureCapacity(state, ord + 1)
  if (nodeExists(state, ord)) return false
  countIncomingBeforeWriting(state, holdsGraphLock)
  writeRecordBeforePlacement(state, ord)
  if (placeThroughTheCore(state, ord, holdsGraphLock)) {
    connectAfterPlacement(state, holdsGraphLock)
    return true
  }
  if (nodeExists(state, ord)) return false
  noteFallback('place')

  if (!holdsGraphLock) lockGraphShared(state.locks)
  try {
    clearTombstone(state, ord)
    const level = levelOfOrdinal(ord, state.mL)
    createNode(state.adjacency, ord, level)
    Atomics.add(state.header, GRAPH_NODE_COUNT, 1)
    if (!claimEntryIfEmpty(state, ord, level)) linkNode(state, ord, level)
  } finally {
    if (!holdsGraphLock) unlockGraphShared(state.locks)
  }
  connectAfterPlacement(state, holdsGraphLock)
  return true
}

export function removeNodeEager(state: HNSWGraphState, ord: number, excludeOrds?: Set<number>): void {
  const maxLayer = nodeMaxLayer(state, ord)
  if (maxLayer === -1) return

  const distance = nodeDistanceFunction(state, state.buildMetric)

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

      const heldNow = new Set<number>(collectNeighbors(state.adjacency, neighborOrd, layer))
      const candidateOrds = new Set<number>(heldNow)
      for (const otherOrd of formerNeighbors) {
        if (otherOrd !== neighborOrd && otherOrd !== ord) {
          if (excludeOrds?.has(otherOrd)) continue
          candidateOrds.add(otherOrd)
        }
      }

      const candidates = state.workspace.repairCandidates
      candidates.size = 0
      for (const candOrd of candidateOrds) {
        const dist = distance(neighborOrd, candOrd)
        if (dist === Number.POSITIVE_INFINITY) {
          if (layer === 0 && heldNow.has(candOrd)) noteUnlinked(state.adjacency, candOrd)
          continue
        }
        appendToList(candidates, candOrd, dist)
      }

      const selected = state.workspace.repairSelection
      selectNeighborsHeuristic(state, candidates, mc, distance, selected)
      if (layer === 0) {
        writeKeepingLastLinks(state, neighborOrd, state.workspace.working, selected, held => heldNow.has(held))
      } else {
        replaceNeighbors(state.adjacency, neighborOrd, layer, selected.ords, selected.size)
      }

      for (let i = 0; i < selected.size; i++) {
        const newConnOrd = selected.ords[i]
        if (layer <= nodeMaxLayer(state, newConnOrd)) {
          addNeighbor(state.adjacency, newConnOrd, layer, neighborOrd)
          pruneConnections(state, newConnOrd, layer, distance)
        }
      }
    }
  }

  const formerBaseNeighbors = collectNeighbors(state.adjacency, ord, 0)
  for (const neighborOrd of formerBaseNeighbors) noteUnlinked(state.adjacency, neighborOrd)
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

export function markTombstone(state: HNSWGraphState, ord: number): void {
  if (!nodeExists(state, ord) || !reachTombstone(state, ord)) return
  const field = nativeFieldFor(state)
  if (field !== null && nativeRemove(state, field, ord)) return
  noteFallback('remove')
  if (Atomics.compareExchange(state.tombstones, ord, 0, 1) === 0) {
    Atomics.add(state.header, GRAPH_TOMBSTONE_COUNT, 1)
  }
}

export function compactTombstones(state: HNSWGraphState): void {
  if (Atomics.load(state.header, GRAPH_TOMBSTONE_COUNT) === 0) return
  countIncomingBeforeWriting(state, true)
  const tombstonedOrds: number[] = []
  const slots = adjacencySlots(state.adjacency)
  for (let ord = 0; ord < slots; ord++) {
    if (isTombstoned(state, ord) && nodeExists(state, ord)) {
      tombstonedOrds.push(ord)
    }
  }
  const nearby = baseNeighboursOfRemoved(state, tombstonedOrds)

  const field = nativeFieldFor(state)
  if (field === null || !nativeCompact(state, field, state.buildMetric)) {
    noteFallback('compact')
    const excl = new Set<number>(tombstonedOrds)
    for (const ord of tombstonedOrds) {
      removeNodeEager(state, ord, excl)
    }
  }
  connectAfterRemoval(state, nearby)
}

export function resetGraph(state: HNSWGraphState): void {
  resetAdjacency(state.adjacency)
  state.tombstones = fixedView(state.adjacency.handles.tombstones, Uint8Array)
  state.tombstones.fill(0)
  Atomics.store(state.header, GRAPH_TOMBSTONE_COUNT, 0)
  Atomics.store(state.header, GRAPH_NODE_COUNT, 0)
  Atomics.store(state.header, GRAPH_ENTRY_POINT, -1)
  Atomics.store(state.header, GRAPH_TOP_LAYER, -1)
  Atomics.store(state.header, GRAPH_INCOMING_UNCOUNTED, 0)
}

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

  for (const ord of shuffleInPlace(liveOrds)) {
    if (!state.store.holdsOrdinal(ord)) continue
    insertNode(state, ord, true)
  }
  connectAfterBuild(state)
}
