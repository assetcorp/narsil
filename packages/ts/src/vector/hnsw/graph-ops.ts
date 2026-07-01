import { type BinaryHeap, createMinHeap } from '../../core/heap'
import type { VectorMetric } from '../brute-force'
import {
  addConnection,
  type DistancePair,
  distanceAsc,
  distanceDesc,
  type HNSWGraphState,
  maxConns,
  nextVisitStamp,
  nodeDistanceByOrd,
  queryDistanceByOrd,
} from './shared'

export function searchLayer(
  state: HNSWGraphState,
  qVec: Float32Array,
  qMag: number,
  eps: number[],
  ef: number,
  layer: number,
  metric: VectorMetric,
  skipTombstones: boolean,
  distFn?: (ord: number) => number,
): BinaryHeap<DistancePair> {
  const getDistance = distFn ?? ((ord: number) => queryDistanceByOrd(state, qVec, qMag, ord, metric))
  const visited = state.visited
  const stamp = nextVisitStamp(state)
  const candidates = createMinHeap<DistancePair>(distanceAsc)
  const results = createMinHeap<DistancePair>(distanceDesc)
  let furthestDist = Number.POSITIVE_INFINITY

  for (const epOrd of eps) {
    if (visited[epOrd] === stamp) continue
    visited[epOrd] = stamp
    const node = state.nodesByOrd[epOrd]
    if (!node) continue
    if (skipTombstones && state.tombstones[epOrd] === 1) continue
    const dist = getDistance(epOrd)
    if (dist === Number.POSITIVE_INFINITY) continue
    const pair = { ord: epOrd, distance: dist }
    candidates.push(pair)
    results.push(pair)
    if (results.size > ef) {
      results.pop()
    }
  }

  const topResult = results.peek()
  if (topResult) furthestDist = topResult.distance

  while (candidates.size > 0) {
    const nearest = candidates.pop()
    if (!nearest) break
    if (nearest.distance > furthestDist) break

    const node = state.nodesByOrd[nearest.ord]
    if (!node || layer >= node.connections.length) continue

    for (const neighborOrd of node.connections[layer]) {
      if (visited[neighborOrd] === stamp) continue
      visited[neighborOrd] = stamp

      if (skipTombstones && state.tombstones[neighborOrd] === 1) continue

      const neighborNode = state.nodesByOrd[neighborOrd]
      if (!neighborNode) continue

      const dist = getDistance(neighborOrd)
      if (dist === Number.POSITIVE_INFINITY) continue

      if (dist < furthestDist || results.size < ef) {
        const pair = { ord: neighborOrd, distance: dist }
        candidates.push(pair)
        results.push(pair)
        if (results.size > ef) {
          results.pop()
        }
        const newTop = results.peek()
        if (newTop) furthestDist = newTop.distance
      }
    }
  }

  return results
}

export function nearestFromHeap(heap: BinaryHeap<DistancePair>): DistancePair | undefined {
  let nearest: DistancePair | undefined
  while (heap.size > 0) {
    nearest = heap.pop()
  }
  return nearest
}

export function selectNeighborsHeuristic(
  state: HNSWGraphState,
  targetOrd: number,
  candidates: DistancePair[],
  maxConnections: number,
  layer: number,
  metric: VectorMetric,
  extendCandidates: boolean,
  keepPruned: boolean,
): DistancePair[] {
  const working = [...candidates]

  if (extendCandidates) {
    const existing = new Set<number>(working.map(c => c.ord))
    for (const cand of candidates) {
      const candNode = state.nodesByOrd[cand.ord]
      if (!candNode || layer >= candNode.connections.length) continue
      for (const adjOrd of candNode.connections[layer]) {
        if (existing.has(adjOrd)) continue
        existing.add(adjOrd)
        const dist = nodeDistanceByOrd(state, targetOrd, adjOrd, metric)
        if (dist === Number.POSITIVE_INFINITY) continue
        working.push({ ord: adjOrd, distance: dist })
      }
    }
  }

  working.sort((a, b) => a.distance - b.distance)

  const selected: DistancePair[] = []
  const discarded: DistancePair[] = []

  for (const candidate of working) {
    if (selected.length >= maxConnections) break

    let accepted = true
    for (const sel of selected) {
      const distBetween = nodeDistanceByOrd(state, candidate.ord, sel.ord, metric)
      if (candidate.distance >= distBetween) {
        accepted = false
        break
      }
    }

    if (accepted) {
      selected.push(candidate)
    } else {
      discarded.push(candidate)
    }
  }

  if (keepPruned) {
    for (const disc of discarded) {
      if (selected.length >= maxConnections) break
      selected.push(disc)
    }
  }

  return selected
}

export function pruneConnections(state: HNSWGraphState, ord: number, layer: number, metric: VectorMetric): void {
  const node = state.nodesByOrd[ord]
  if (!node) return
  const mc = maxConns(state, layer)
  if (node.connections[layer].length <= mc) return

  const conns: DistancePair[] = []
  for (const connOrd of node.connections[layer]) {
    const dist = nodeDistanceByOrd(state, ord, connOrd, metric)
    if (dist === Number.POSITIVE_INFINITY) continue
    conns.push({ ord: connOrd, distance: dist })
  }

  const pruned = selectNeighborsHeuristic(state, ord, conns, mc, layer, metric, false, true)
  const next: number[] = []
  for (const p of pruned) addConnection(next, p.ord)
  node.connections[layer] = next
}
