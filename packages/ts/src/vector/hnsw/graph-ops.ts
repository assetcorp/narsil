import type { VectorMetric } from '../brute-force'
import { layerArray, layerBase, readNeighbors, replaceNeighbors } from './adjacency'
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
  skipTombstones: boolean,
  distFn: ((ord: number) => number) | undefined,
  results: DistanceList,
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
    if (skipTombstones && isTombstoned(state, epOrd)) continue
    const dist = getDistance(epOrd)
    if (dist === Number.POSITIVE_INFINITY) continue
    pushHeap(frontier, epOrd, dist)
    pushHeap(found, epOrd, dist)
    if (found.size > ef) {
      popHeap(found)
    }
  }

  if (found.size > 0) furthestDist = found.distances[0]

  while (popHeap(frontier)) {
    if (frontier.topDistance > furthestDist) break

    const count = readNeighborsLocked(state, frontier.topOrd, layer)
    for (let i = 0; i < count; i++) {
      const neighborOrd = scratch[i]
      ensureVisited(state, neighborOrd + 1)
      if (state.visited[neighborOrd] === stamp) continue
      state.visited[neighborOrd] = stamp

      if (skipTombstones && isTombstoned(state, neighborOrd)) continue

      if (!nodeExists(state, neighborOrd)) continue

      const dist = getDistance(neighborOrd)
      if (dist === Number.POSITIVE_INFINITY) continue

      if (dist < furthestDist || found.size < ef) {
        pushHeap(frontier, neighborOrd, dist)
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
    if (dist === Number.POSITIVE_INFINITY) continue
    candidates.ords[candidates.size] = connOrd
    candidates.distances[candidates.size] = dist
    candidates.size += 1
  }

  const kept = state.workspace.pruneSelection
  selectNeighborsHeuristic(state, candidates, mc, distance, kept)
  replaceNeighbors(adjacency, ord, layer, kept.ords, kept.size)
}
