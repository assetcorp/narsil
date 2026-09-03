import type { VectorMetric } from '../brute-force'
import { layerArray, layerBase, replaceNeighbors } from './adjacency'
import {
  type HNSWGraphState,
  type HNSWSearchState,
  maxConns,
  nextVisitStamp,
  nodeDistanceByOrd,
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

/**
 * Walks one layer of the graph from the entry points the workspace holds and
 * writes the nearest candidates it finds into the given list, nearest first.
 *
 * @param state The graph to walk.
 * @param qVec The query vector.
 * @param qMag The query vector's magnitude.
 * @param ef How many candidates the walk keeps.
 * @param layer The layer to walk.
 * @param metric The distance metric to rank by.
 * @param skipTombstones True to leave removed documents out of the results.
 * @param distFn The distance function to measure with, or undefined to measure
 * against the query vector itself.
 * @param results The list the walk fills, nearest first.
 *
 * @internal
 */
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
  const adjacency = state.adjacency
  const neighbors = layerArray(adjacency, layer)
  const visited = state.visited
  const stamp = nextVisitStamp(state)

  resetHeap(frontier)
  resetHeap(found)
  let furthestDist = Number.POSITIVE_INFINITY

  for (let i = 0; i < workspace.entryPointCount; i++) {
    const epOrd = workspace.entryPoints[i]
    if (visited[epOrd] === stamp) continue
    visited[epOrd] = stamp
    if (!nodeExists(state, epOrd)) continue
    if (skipTombstones && state.tombstones[epOrd] === 1) continue
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

    const base = layerBase(adjacency, frontier.topOrd, layer)
    if (base === -1) continue

    const count = neighbors[base]
    for (let i = 1; i <= count; i++) {
      const neighborOrd = neighbors[base + i]
      if (visited[neighborOrd] === stamp) continue
      visited[neighborOrd] = stamp

      if (skipTombstones && state.tombstones[neighborOrd] === 1) continue

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

/**
 * Chooses which candidates a node links to, keeping a candidate only where it
 * is nearer to that node than to every candidate already kept.
 *
 * The rule stops at that diverse set, as hnswlib, Lucene, and Qdrant do, so a
 * node's list holds fewer links than its cap wherever the candidates crowd
 * together.
 *
 * @param state The graph to measure in.
 * @param candidates The candidates to choose from, each with its distance to
 * the node taking the links, which the call leaves unchanged.
 * @param maxConnections The most links the node may take.
 * @param metric The distance metric to rank by.
 * @param selected The list the chosen candidates are written to.
 *
 * @internal
 */
export function selectNeighborsHeuristic(
  state: HNSWGraphState,
  candidates: DistanceList,
  maxConnections: number,
  metric: VectorMetric,
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
      const distBetween = nodeDistanceByOrd(state, candidateOrd, selected.ords[s], metric)
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

/**
 * Cuts a node's neighbour list back to its cap by applying the selection rule
 * to the neighbours it holds.
 *
 * @param state The graph to change.
 * @param ord The node whose list is over its cap.
 * @param layer The layer the list belongs to.
 * @param metric The distance metric to rank by.
 *
 * @internal
 */
export function pruneConnections(state: HNSWGraphState, ord: number, layer: number, metric: VectorMetric): void {
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
    const dist = nodeDistanceByOrd(state, ord, connOrd, metric)
    if (dist === Number.POSITIVE_INFINITY) continue
    candidates.ords[candidates.size] = connOrd
    candidates.distances[candidates.size] = dist
    candidates.size += 1
  }

  const kept = state.workspace.pruneSelection
  selectNeighborsHeuristic(state, candidates, mc, metric, kept)
  replaceNeighbors(adjacency, ord, layer, kept.ords, kept.size)
}
