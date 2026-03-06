import type { ScoredDocument, VectorEntry } from '../types/internal'
import type { VectorMetric } from './brute-force'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from './similarity'

const MAX_LAYER_CAP = 32

interface HNSWNode {
  docId: string
  vector: Float32Array
  mag: number
  maxLayer: number
  connections: Set<string>[]
}

interface DistancePair {
  docId: string
  distance: number
}

export interface HNSWConfig {
  m?: number
  efConstruction?: number
  metric?: VectorMetric
}

export interface SerializedHNSWGraph {
  entryPoint: string
  maxLayer: number
  m: number
  efConstruction: number
  nodes: Array<[string, number, Array<[number, string[]]>]>
}

export interface HNSWIndex {
  readonly dimension: number
  readonly size: number
  readonly entryPointId: string | null
  readonly topLayer: number
  readonly m: number
  readonly efConstruction: number
  readonly metric: VectorMetric

  insert(docId: string, vector: Float32Array): void
  remove(docId: string): void
  has(docId: string): boolean
  search(
    query: Float32Array,
    k: number,
    searchMetric: VectorMetric,
    minSimilarity: number,
    filterDocIds?: Set<string>,
    efSearch?: number,
  ): ScoredDocument[]
  clear(): void
  entries(): IterableIterator<[string, VectorEntry]>

  serialize(): SerializedHNSWGraph
  deserialize(data: SerializedHNSWGraph, vectors: Map<string, { vector: Float32Array; mag: number }>): void
}

function toDistance(a: Float32Array, b: Float32Array, magA: number, magB: number, metric: VectorMetric): number {
  switch (metric) {
    case 'cosine':
      return 1 - cosineSimilarityWithMagnitudes(a, b, magA, magB)
    case 'dotProduct':
      return -dotProduct(a, b)
    case 'euclidean':
      return euclideanDistance(a, b)
  }
}

function toScore(distance: number, metric: VectorMetric): number {
  switch (metric) {
    case 'cosine':
      return 1 - distance
    case 'dotProduct':
      return -distance
    case 'euclidean':
      return 1 / (1 + distance)
  }
}

function insertSorted(arr: DistancePair[], item: DistancePair): void {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid].distance < item.distance) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  arr.splice(lo, 0, item)
}

export function createHNSWIndex(dimension: number, config?: HNSWConfig): HNSWIndex {
  const M = config?.m ?? 16
  const Mmax0 = M * 2
  const efCons = config?.efConstruction ?? 200
  const buildMetric = config?.metric ?? 'cosine'
  const mL = 1 / Math.log(M)

  const nodes = new Map<string, HNSWNode>()
  let entryPointId: string | null = null
  let topLayer = -1

  function randomLevel(): number {
    let u = Math.random()
    if (u === 0) u = Number.MIN_VALUE
    return Math.min(Math.floor(-Math.log(u) * mL), MAX_LAYER_CAP)
  }

  function nodeDistance(a: HNSWNode, b: HNSWNode, metric: VectorMetric): number {
    return toDistance(a.vector, b.vector, a.mag, b.mag, metric)
  }

  function queryDistance(qVec: Float32Array, qMag: number, node: HNSWNode, metric: VectorMetric): number {
    return toDistance(qVec, node.vector, qMag, node.mag, metric)
  }

  function maxConns(layer: number): number {
    return layer === 0 ? Mmax0 : M
  }

  /**
   * Algorithm 2 from Malkov & Yashunin (2018).
   *
   * Greedy search on a single layer returning up to `ef` nearest neighbors
   * of `qVec`, starting from `eps`. Results are sorted by distance ascending.
   */
  function searchLayer(
    qVec: Float32Array,
    qMag: number,
    eps: string[],
    ef: number,
    layer: number,
    metric: VectorMetric,
  ): DistancePair[] {
    const visited = new Set<string>()
    const candidates: DistancePair[] = []
    const results: DistancePair[] = []

    for (const epId of eps) {
      if (visited.has(epId)) continue
      visited.add(epId)
      const node = nodes.get(epId)
      if (!node) continue
      const dist = queryDistance(qVec, qMag, node, metric)
      insertSorted(candidates, { docId: epId, distance: dist })
      insertSorted(results, { docId: epId, distance: dist })
    }

    while (candidates.length > 0) {
      const nearest = candidates.shift()
      if (!nearest) break
      const furthest = results[results.length - 1]
      if (nearest.distance > furthest.distance) break

      const node = nodes.get(nearest.docId)
      if (!node || layer >= node.connections.length) continue

      for (const neighborId of node.connections[layer]) {
        if (visited.has(neighborId)) continue
        visited.add(neighborId)

        const neighborNode = nodes.get(neighborId)
        if (!neighborNode) continue

        const dist = queryDistance(qVec, qMag, neighborNode, metric)
        const currentFurthest = results[results.length - 1]

        if (dist < currentFurthest.distance || results.length < ef) {
          insertSorted(candidates, { docId: neighborId, distance: dist })
          insertSorted(results, { docId: neighborId, distance: dist })
          if (results.length > ef) {
            results.pop()
          }
        }
      }
    }

    return results
  }

  /**
   * Algorithm 4 from Malkov & Yashunin (2018).
   *
   * Heuristic neighbor selection that promotes graph diversity: a candidate
   * is accepted only when it is closer to the target than to every
   * already-selected neighbor, preventing clusters of nearby neighbors.
   */
  function selectNeighborsHeuristic(
    targetVec: Float32Array,
    targetMag: number,
    candidates: DistancePair[],
    maxConnections: number,
    layer: number,
    metric: VectorMetric,
    extendCandidates: boolean,
    keepPruned: boolean,
  ): DistancePair[] {
    const working = [...candidates].sort((a, b) => a.distance - b.distance)

    if (extendCandidates) {
      const existing = new Set(working.map(c => c.docId))
      for (const cand of candidates) {
        const candNode = nodes.get(cand.docId)
        if (!candNode || layer >= candNode.connections.length) continue
        for (const adjId of candNode.connections[layer]) {
          if (existing.has(adjId)) continue
          existing.add(adjId)
          const adjNode = nodes.get(adjId)
          if (!adjNode) continue
          const dist = queryDistance(targetVec, targetMag, adjNode, metric)
          working.push({ docId: adjId, distance: dist })
        }
      }
      working.sort((a, b) => a.distance - b.distance)
    }

    const selected: DistancePair[] = []
    const discarded: DistancePair[] = []

    for (const candidate of working) {
      if (selected.length >= maxConnections) break

      let accepted = true
      for (const sel of selected) {
        const selNode = nodes.get(sel.docId)
        const candNode = nodes.get(candidate.docId)
        if (!selNode || !candNode) continue
        const distBetween = nodeDistance(candNode, selNode, metric)
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

  function pruneConnections(node: HNSWNode, layer: number, metric: VectorMetric): void {
    const mc = maxConns(layer)
    if (node.connections[layer].size <= mc) return

    const conns: DistancePair[] = []
    for (const connId of node.connections[layer]) {
      const connNode = nodes.get(connId)
      if (!connNode) continue
      conns.push({
        docId: connId,
        distance: nodeDistance(node, connNode, metric),
      })
    }

    const pruned = selectNeighborsHeuristic(node.vector, node.mag, conns, mc, layer, metric, false, true)
    node.connections[layer] = new Set(pruned.map(p => p.docId))
  }

  /**
   * Algorithm 1 from Malkov & Yashunin (2018).
   *
   * Inserts a vector into the multi-layer graph. A random layer is sampled
   * with exponentially decaying probability. Upper layers are traversed
   * greedily (ef=1) to find an entry point, then efConstruction candidates
   * are evaluated per layer to select neighbors via the diversity heuristic.
   */
  function insert(docId: string, vector: Float32Array): void {
    if (vector.length !== dimension) {
      throw new Error(`Vector dimension mismatch: expected ${dimension}, got ${vector.length}`)
    }

    if (nodes.has(docId)) {
      remove(docId)
    }

    const mag = magnitude(vector)
    const l = randomLevel()

    const node: HNSWNode = {
      docId,
      vector,
      mag,
      maxLayer: l,
      connections: Array.from({ length: l + 1 }, () => new Set<string>()),
    }

    nodes.set(docId, node)

    if (entryPointId === null) {
      entryPointId = docId
      topLayer = l
      return
    }

    const metric = buildMetric
    let currentEPs = [entryPointId]

    for (let layer = topLayer; layer > l; layer--) {
      const nearest = searchLayer(vector, mag, currentEPs, 1, layer, metric)
      if (nearest.length > 0) {
        currentEPs = [nearest[0].docId]
      }
    }

    for (let layer = Math.min(l, topLayer); layer >= 0; layer--) {
      const mc = maxConns(layer)
      const nearest = searchLayer(vector, mag, currentEPs, efCons, layer, metric)
      const neighbors = selectNeighborsHeuristic(vector, mag, nearest, mc, layer, metric, false, true)

      for (const neighbor of neighbors) {
        node.connections[layer].add(neighbor.docId)
        const neighborNode = nodes.get(neighbor.docId)
        if (neighborNode && layer < neighborNode.connections.length) {
          neighborNode.connections[layer].add(docId)
          pruneConnections(neighborNode, layer, metric)
        }
      }

      if (nearest.length > 0) {
        currentEPs = nearest.map(n => n.docId)
      }
    }

    if (l > topLayer) {
      entryPointId = docId
      topLayer = l
    }
  }

  /**
   * Removes a node and reconnects its former neighbors.
   *
   * For each layer the node occupied:
   *   1. Disconnect the node from all its neighbors.
   *   2. For each neighbor below its connection limit, select replacement
   *      connections from the deleted node's other former neighbors using the
   *      diversity heuristic.
   *   3. If the removed node was the entry point, elect the node with the
   *      highest layer as the new entry point.
   */
  function remove(docId: string): void {
    const node = nodes.get(docId)
    if (!node) return

    const metric = buildMetric

    for (let layer = 0; layer <= node.maxLayer; layer++) {
      if (layer >= node.connections.length) continue

      const formerNeighborIds = new Set(node.connections[layer])

      for (const neighborId of formerNeighborIds) {
        const neighborNode = nodes.get(neighborId)
        if (neighborNode && layer < neighborNode.connections.length) {
          neighborNode.connections[layer].delete(docId)
        }
      }

      for (const neighborId of formerNeighborIds) {
        const neighborNode = nodes.get(neighborId)
        if (!neighborNode || layer >= neighborNode.connections.length) continue

        const mc = maxConns(layer)
        if (neighborNode.connections[layer].size >= mc) continue

        const candidateIds = new Set(neighborNode.connections[layer])
        for (const otherId of formerNeighborIds) {
          if (otherId !== neighborId && otherId !== docId) {
            candidateIds.add(otherId)
          }
        }

        const candidates: DistancePair[] = []
        for (const candId of candidateIds) {
          const candNode = nodes.get(candId)
          if (!candNode) continue
          candidates.push({
            docId: candId,
            distance: nodeDistance(neighborNode, candNode, metric),
          })
        }

        const selected = selectNeighborsHeuristic(
          neighborNode.vector,
          neighborNode.mag,
          candidates,
          mc,
          layer,
          metric,
          false,
          false,
        )

        const newConns = new Set(selected.map(s => s.docId))
        neighborNode.connections[layer] = newConns

        for (const newConnId of newConns) {
          const newConnNode = nodes.get(newConnId)
          if (newConnNode && layer < newConnNode.connections.length) {
            newConnNode.connections[layer].add(neighborId)
            pruneConnections(newConnNode, layer, metric)
          }
        }
      }
    }

    nodes.delete(docId)

    if (entryPointId === docId) {
      if (nodes.size === 0) {
        entryPointId = null
        topLayer = -1
        return
      }
      let newEntryId: string | null = null
      let newTopLayer = -1
      for (const [nId, n] of nodes) {
        if (n.maxLayer > newTopLayer) {
          newTopLayer = n.maxLayer
          newEntryId = nId
        }
      }
      entryPointId = newEntryId
      topLayer = newTopLayer
    }
  }

  /**
   * Algorithm 5 from Malkov & Yashunin (2018).
   *
   * K-nearest neighbor search. Upper layers are traversed greedily to reach
   * an entry zone, then layer 0 is searched with the full ef budget. When
   * `filterDocIds` is provided, ef is increased proportionally to compensate
   * for filtered-out candidates.
   */
  function search(
    query: Float32Array,
    k: number,
    searchMetric: VectorMetric,
    minSimilarity: number,
    filterDocIds?: Set<string>,
    efSearch?: number,
  ): ScoredDocument[] {
    if (query.length !== dimension) {
      throw new Error(`Query dimension mismatch: expected ${dimension}, got ${query.length}`)
    }

    if (entryPointId === null || nodes.size === 0) {
      return []
    }

    let ef = Math.max(efSearch ?? 50, k)
    if (filterDocIds && filterDocIds.size < nodes.size) {
      const selectivity = filterDocIds.size / nodes.size
      ef = Math.max(ef, Math.ceil(k / Math.max(selectivity, 0.01)))
      ef = Math.min(ef, nodes.size)
    }

    const qMag = magnitude(query)
    let currentEPs = [entryPointId]

    for (let layer = topLayer; layer >= 1; layer--) {
      const nearest = searchLayer(query, qMag, currentEPs, 1, layer, searchMetric)
      if (nearest.length > 0) {
        currentEPs = [nearest[0].docId]
      }
    }

    const candidates = searchLayer(query, qMag, currentEPs, ef, 0, searchMetric)

    const results: ScoredDocument[] = []
    for (const cand of candidates) {
      if (filterDocIds && !filterDocIds.has(cand.docId)) continue
      const score = toScore(cand.distance, searchMetric)
      if (score < minSimilarity) continue
      results.push({
        docId: cand.docId,
        score,
        termFrequencies: {},
        fieldLengths: {},
        idf: {},
      })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, k)
  }

  function serialize(): SerializedHNSWGraph {
    const nodeArray: Array<[string, number, Array<[number, string[]]>]> = []
    for (const [docId, node] of nodes) {
      const layerConns: Array<[number, string[]]> = []
      for (let layer = 0; layer < node.connections.length; layer++) {
        if (node.connections[layer].size > 0) {
          layerConns.push([layer, Array.from(node.connections[layer])])
        }
      }
      nodeArray.push([docId, node.maxLayer, layerConns])
    }
    return {
      entryPoint: entryPointId ?? '',
      maxLayer: topLayer,
      m: M,
      efConstruction: efCons,
      nodes: nodeArray,
    }
  }

  function deserialize(data: SerializedHNSWGraph, vectors: Map<string, { vector: Float32Array; mag: number }>): void {
    nodes.clear()
    entryPointId = data.entryPoint
    topLayer = data.maxLayer

    for (const [docId, maxLayer, layerConns] of data.nodes) {
      const vecData = vectors.get(docId)
      if (!vecData) continue

      const connections: Set<string>[] = Array.from({ length: maxLayer + 1 }, () => new Set<string>())
      for (const [layer, neighbors] of layerConns) {
        if (layer < connections.length) {
          connections[layer] = new Set(neighbors)
        }
      }

      nodes.set(docId, {
        docId,
        vector: vecData.vector,
        mag: vecData.mag,
        maxLayer,
        connections,
      })
    }
  }

  function clear(): void {
    nodes.clear()
    entryPointId = null
    topLayer = -1
  }

  function* entriesIterator(): IterableIterator<[string, VectorEntry]> {
    for (const [docId, node] of nodes) {
      yield [docId, { docId, vector: node.vector, magnitude: node.mag }]
    }
  }

  return {
    get dimension() {
      return dimension
    },
    get size() {
      return nodes.size
    },
    get entryPointId() {
      return entryPointId
    },
    get topLayer() {
      return topLayer
    },
    get m() {
      return M
    },
    get efConstruction() {
      return efCons
    },
    get metric() {
      return buildMetric
    },
    insert,
    remove,
    has: (docId: string) => nodes.has(docId),
    search,
    clear,
    entries: entriesIterator,
    serialize,
    deserialize,
  }
}
