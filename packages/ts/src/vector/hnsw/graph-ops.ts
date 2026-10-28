import type { VectorMetric } from '../brute-force'
import { type OrdinalFilter, ordinalFilterHas } from '../ordinal-filter'
import { layerArray, layerBase, noteUnlinked, readNeighbors, writeNeighbors } from './adjacency'
import { FARTHEST_REJECTED_LINKS_KEPT } from './constants'
import { writeKeepingLastLinks } from './last-links'
import { beginNodeRead, nodeReadHeld } from './locks'
import {
  ensureVisited,
  type HNSWGraphState,
  type HNSWSearchState,
  isTombstoned,
  maxConns,
  nextVisitStamp,
  nodeExists,
  queryDistanceByOrd,
} from './shared'
import {
  copyList,
  type DistanceList,
  drainHeapNearestFirst,
  ensureListCapacity,
  popHeap,
  pushHeap,
  resetHeap,
  sortListByDistance,
} from './workspace'

export function readNeighborsLocked(state: HNSWSearchState, ord: number, layer: number): number {
  for (;;) {
    const version = beginNodeRead(state.locks, ord)
    const count = readNeighbors(state.adjacency, ord, layer, state.neighborScratch)
    if (nodeReadHeld(state.locks, ord, version)) return count
  }
}

export function searchLayer(
  state: HNSWSearchState,
  qVec: Float32Array,
  qMag: number,
  ef: number,
  layer: number,
  metric: VectorMetric,
  excludeTombstones: boolean,
  distFn: ((ord: number) => number) | undefined,
  results: DistanceList,
  accepted?: OrdinalFilter,
): void {
  const getDistance = distFn ?? ((ord: number) => queryDistanceByOrd(state, qVec, qMag, ord, metric))
  const workspace = state.workspace
  const frontier = workspace.frontier
  const found = workspace.found
  const scratch = state.neighborScratch
  const stamp = nextVisitStamp(state)

  resetHeap(frontier)
  resetHeap(found)
  let furthestDist = Number.POSITIVE_INFINITY

  for (let i = 0; i < workspace.entryPointCount; i++) {
    const epOrd = workspace.entryPoints[i]
    ensureVisited(state, epOrd + 1)
    if (state.visited[epOrd] === stamp) continue
    state.visited[epOrd] = stamp
    if (!nodeExists(state, epOrd)) continue
    const dist = getDistance(epOrd)
    if (dist === Number.POSITIVE_INFINITY) continue
    pushHeap(frontier, epOrd, dist)
    if (excludeTombstones && isTombstoned(state, epOrd)) continue
    if (accepted && !ordinalFilterHas(accepted, epOrd)) continue
    pushHeap(found, epOrd, dist)
    if (found.size > ef) {
      popHeap(found)
    }
  }

  if (found.size > 0) furthestDist = found.distances[0]

  while (popHeap(frontier)) {
    if (frontier.topDistance > furthestDist && found.size >= ef) break

    const count = readNeighborsLocked(state, frontier.topOrd, layer)
    for (let i = 0; i < count; i++) {
      const neighborOrd = scratch[i]
      ensureVisited(state, neighborOrd + 1)
      if (state.visited[neighborOrd] === stamp) continue
      state.visited[neighborOrd] = stamp

      if (!nodeExists(state, neighborOrd)) continue

      const dist = getDistance(neighborOrd)
      if (dist === Number.POSITIVE_INFINITY) continue

      if (dist < furthestDist || found.size < ef) {
        pushHeap(frontier, neighborOrd, dist)
        if (excludeTombstones && isTombstoned(state, neighborOrd)) continue
        if (accepted && !ordinalFilterHas(accepted, neighborOrd)) continue
        pushHeap(found, neighborOrd, dist)
        if (found.size > ef) {
          popHeap(found)
        }
        furthestDist = found.distances[0]
      }
    }
  }

  drainHeapNearestFirst(found, results)
}

export function selectNeighborsHeuristic(
  state: HNSWGraphState,
  candidates: DistanceList,
  maxConnections: number,
  distance: (aOrd: number, bOrd: number) => number,
  selected: DistanceList,
): void {
  const working = state.workspace.working
  copyList(candidates, working)
  sortListByDistance(working)

  ensureListCapacity(selected, Math.min(maxConnections, working.size))
  selected.size = 0

  for (let i = 0; i < working.size; i++) {
    if (selected.size >= maxConnections) break

    const candidateOrd = working.ords[i]
    const candidateDistance = working.distances[i]

    let accepted = true
    for (let s = 0; s < selected.size; s++) {
      const distBetween = distance(candidateOrd, selected.ords[s])
      if (candidateDistance >= distBetween) {
        accepted = false
        break
      }
    }

    if (!accepted) continue
    selected.ords[selected.size] = candidateOrd
    selected.distances[selected.size] = candidateDistance
    selected.size += 1
  }
  keepFarthestRejected(working, maxConnections, selected)
}

function holdsOrd(list: DistanceList, ord: number): boolean {
  for (let i = 0; i < list.size; i++) if (list.ords[i] === ord) return true
  return false
}

function keepFarthestRejected(sorted: DistanceList, maxConnections: number, selected: DistanceList): void {
  let kept = 0
  for (let i = sorted.size - 1; i >= 0 && kept < FARTHEST_REJECTED_LINKS_KEPT; i--) {
    if (selected.size >= maxConnections) return
    if (holdsOrd(selected, sorted.ords[i])) continue
    selected.ords[selected.size] = sorted.ords[i]
    selected.distances[selected.size] = sorted.distances[i]
    selected.size += 1
    kept += 1
  }
}

export function pruneConnections(
  state: HNSWGraphState,
  ord: number,
  layer: number,
  distance: (aOrd: number, bOrd: number) => number,
): void {
  const adjacency = state.adjacency
  const base = layerBase(adjacency, ord, layer)
  if (base === -1) return
  const mc = maxConns(state, layer)
  const neighbors = layerArray(adjacency, layer)
  const count = neighbors[base]
  if (count <= mc) return

  const candidates = state.workspace.pruneCandidates
  candidates.size = 0
  ensureListCapacity(candidates, count)
  for (let i = 1; i <= count; i++) {
    const connOrd = neighbors[base + i]
    const dist = distance(ord, connOrd)
    if (dist === Number.POSITIVE_INFINITY) {
      if (layer === 0) noteUnlinked(adjacency, connOrd)
      continue
    }
    candidates.ords[candidates.size] = connOrd
    candidates.distances[candidates.size] = dist
    candidates.size += 1
  }

  const kept = state.workspace.pruneSelection
  selectNeighborsHeuristic(state, candidates, mc, distance, kept)
  if (layer === 0) {
    writeKeepingLastLinks(state, ord, state.workspace.working, kept, everyCandidateWasHeld)
    return
  }
  writeNeighbors(adjacency, ord, layer, kept.ords, kept.size)
}

function everyCandidateWasHeld(): boolean {
  return true
}
