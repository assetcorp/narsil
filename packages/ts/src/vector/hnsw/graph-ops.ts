import { type BinaryHeap, createMinHeap } from '../../core/heap'
import type { VectorMetric } from '../brute-force'
import {
  type DistancePair,
  distanceAsc,
  distanceDesc,
  type HNSWGraphState,
  maxConns,
  nodeDistance,
  queryDistance,
} from './shared'

export function searchLayer(
  state: HNSWGraphState,
  qVec: Float32Array,
  qMag: number,
  eps: string[],
  ef: number,
  layer: number,
  metric: VectorMetric,
  skipTombstones: boolean,
  distFn?: (nodeId: string) => number,
): BinaryHeap<DistancePair> {
  const getDistance = distFn ?? ((nodeId: string) => queryDistance(state, qVec, qMag, nodeId, metric))
  const visited = new Set<string>()
  const candidates = createMinHeap<DistancePair>(distanceAsc)
  const results = createMinHeap<DistancePair>(distanceDesc)
  let furthestDist = Number.POSITIVE_INFINITY

  for (const epId of eps) {
    if (visited.has(epId)) continue
    visited.add(epId)
    const node = state.nodes.get(epId)
    if (!node) continue
    if (skipTombstones && state.tombstones.has(epId)) continue
    const dist = getDistance(epId)
    if (dist === Number.POSITIVE_INFINITY) continue
    const pair = { docId: epId, distance: dist }
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

    const node = state.nodes.get(nearest.docId)
    if (!node || layer >= node.connections.length) continue

    for (const neighborId of node.connections[layer]) {
      if (visited.has(neighborId)) continue
      visited.add(neighborId)

      if (skipTombstones && state.tombstones.has(neighborId)) continue

      const neighborNode = state.nodes.get(neighborId)
      if (!neighborNode) continue

      const dist = getDistance(neighborId)
      if (dist === Number.POSITIVE_INFINITY) continue

      if (dist < furthestDist || results.size < ef) {
        const pair = { docId: neighborId, distance: dist }
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
  targetId: string,
  candidates: DistancePair[],
  maxConnections: number,
  layer: number,
  metric: VectorMetric,
  extendCandidates: boolean,
  keepPruned: boolean,
): DistancePair[] {
  const working = [...candidates]

  if (extendCandidates) {
    const existing = new Set(working.map(c => c.docId))
    for (const cand of candidates) {
      const candNode = state.nodes.get(cand.docId)
      if (!candNode || layer >= candNode.connections.length) continue
      for (const adjId of candNode.connections[layer]) {
        if (existing.has(adjId)) continue
        existing.add(adjId)
        const dist = nodeDistance(state, targetId, adjId, metric)
        if (dist === Number.POSITIVE_INFINITY) continue
        working.push({ docId: adjId, distance: dist })
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
      const distBetween = nodeDistance(state, candidate.docId, sel.docId, metric)
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

export function pruneConnections(state: HNSWGraphState, nodeId: string, layer: number, metric: VectorMetric): void {
  const node = state.nodes.get(nodeId)
  if (!node) return
  const mc = maxConns(state, layer)
  if (node.connections[layer].size <= mc) return

  const conns: DistancePair[] = []
  for (const connId of node.connections[layer]) {
    const dist = nodeDistance(state, nodeId, connId, metric)
    if (dist === Number.POSITIVE_INFINITY) continue
    conns.push({ docId: connId, distance: dist })
  }

  const pruned = selectNeighborsHeuristic(state, nodeId, conns, mc, layer, metric, false, true)
  node.connections[layer] = new Set(pruned.map(p => p.docId))
}
