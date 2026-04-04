import { type BinaryHeap, createMinHeap } from '../core/heap'
import type { ScoredDocument, VectorEntry } from '../types/internal'
import type { VectorMetric } from './brute-force'
import type { QuantizedQuery, ScalarQuantizer } from './scalar-quantization'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from './similarity'
import type { VectorStore, VectorStoreEntry } from './vector-store'

const MAX_LAYER_CAP = 32
const COMPACTION_TOMBSTONE_RATIO = 0.1
const COMPACTION_ABSOLUTE_THRESHOLD = 1000

interface HNSWNode {
  docId: string
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
  entryPoint: string | null
  maxLayer: number
  m: number
  efConstruction: number
  metric?: VectorMetric
  nodes: Array<[string, number, Array<[number, string[]]>]>
}

export interface HNSWIndex {
  readonly dimension: number
  readonly size: number
  readonly tombstoneCount: number
  readonly entryPointId: string | null
  readonly topLayer: number
  readonly m: number
  readonly efConstruction: number
  readonly metric: VectorMetric

  insertNode(docId: string): void
  markTombstone(docId: string): void
  has(docId: string): boolean
  isTombstoned(docId: string): boolean
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
  compactionNeeded(): boolean
  compact(): void
  compactTombstones(): void
  rebuild(): void

  serialize(): SerializedHNSWGraph
  deserialize(data: SerializedHNSWGraph): void
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

const distanceAsc = (a: DistancePair, b: DistancePair): number => a.distance - b.distance
const distanceDesc = (a: DistancePair, b: DistancePair): number => b.distance - a.distance

const SQ8_OVERSELECTION_FACTOR = 2

export function createHNSWIndex(
  dimension: number,
  store: VectorStore,
  config?: HNSWConfig,
  quantizer?: ScalarQuantizer,
): HNSWIndex {
  const M = config?.m ?? 16
  const Mmax0 = M * 2
  const efCons = config?.efConstruction ?? 200
  const buildMetric = config?.metric ?? 'cosine'
  const mL = 1 / Math.log(M)

  const nodes = new Map<string, HNSWNode>()
  const tombstones = new Set<string>()
  let entryPointId: string | null = null
  let topLayer = -1

  function randomLevel(): number {
    let u = Math.random()
    if (u === 0) u = Number.MIN_VALUE
    return Math.min(Math.floor(-Math.log(u) * mL), MAX_LAYER_CAP)
  }

  function getEntry(docId: string): VectorStoreEntry | undefined {
    return store.get(docId)
  }

  function nodeDistance(aId: string, bId: string, metric: VectorMetric): number {
    const a = getEntry(aId)
    const b = getEntry(bId)
    if (!a || !b) return Number.POSITIVE_INFINITY
    return toDistance(a.vector, b.vector, a.magnitude, b.magnitude, metric)
  }

  function queryDistance(qVec: Float32Array, qMag: number, nodeId: string, metric: VectorMetric): number {
    const entry = getEntry(nodeId)
    if (!entry) return Number.POSITIVE_INFINITY
    return toDistance(qVec, entry.vector, qMag, entry.magnitude, metric)
  }

  function maxConns(layer: number): number {
    return layer === 0 ? Mmax0 : M
  }

  function searchLayer(
    qVec: Float32Array,
    qMag: number,
    eps: string[],
    ef: number,
    layer: number,
    metric: VectorMetric,
    skipTombstones: boolean,
    distFn?: (nodeId: string) => number,
  ): BinaryHeap<DistancePair> {
    const getDistance = distFn ?? ((nodeId: string) => queryDistance(qVec, qMag, nodeId, metric))
    const visited = new Set<string>()
    const candidates = createMinHeap<DistancePair>(distanceAsc)
    const results = createMinHeap<DistancePair>(distanceDesc)
    let furthestDist = Number.POSITIVE_INFINITY

    for (const epId of eps) {
      if (visited.has(epId)) continue
      visited.add(epId)
      const node = nodes.get(epId)
      if (!node) continue
      if (skipTombstones && tombstones.has(epId)) continue
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

      const node = nodes.get(nearest.docId)
      if (!node || layer >= node.connections.length) continue

      for (const neighborId of node.connections[layer]) {
        if (visited.has(neighborId)) continue
        visited.add(neighborId)

        if (skipTombstones && tombstones.has(neighborId)) continue

        const neighborNode = nodes.get(neighborId)
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

  function nearestFromHeap(heap: BinaryHeap<DistancePair>): DistancePair | undefined {
    let nearest: DistancePair | undefined
    while (heap.size > 0) {
      nearest = heap.pop()
    }
    return nearest
  }

  function selectNeighborsHeuristic(
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
        const candNode = nodes.get(cand.docId)
        if (!candNode || layer >= candNode.connections.length) continue
        for (const adjId of candNode.connections[layer]) {
          if (existing.has(adjId)) continue
          existing.add(adjId)
          const dist = nodeDistance(targetId, adjId, metric)
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
        const distBetween = nodeDistance(candidate.docId, sel.docId, metric)
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

  function pruneConnections(nodeId: string, node: HNSWNode, layer: number, metric: VectorMetric): void {
    const mc = maxConns(layer)
    if (node.connections[layer].size <= mc) return

    const conns: DistancePair[] = []
    for (const connId of node.connections[layer]) {
      const dist = nodeDistance(nodeId, connId, metric)
      if (dist === Number.POSITIVE_INFINITY) continue
      conns.push({ docId: connId, distance: dist })
    }

    const pruned = selectNeighborsHeuristic(nodeId, conns, mc, layer, metric, false, true)
    node.connections[layer] = new Set(pruned.map(p => p.docId))
  }

  function insertNode(docId: string): void {
    const vecEntry = store.get(docId)
    if (!vecEntry) {
      throw new Error(`Cannot insert HNSW node: vector for "${docId}" not found in VectorStore`)
    }

    if (vecEntry.vector.length !== dimension) {
      throw new Error(`Vector dimension mismatch: expected ${dimension}, got ${vecEntry.vector.length}`)
    }

    if (nodes.has(docId)) {
      removeNodeEager(docId)
    }

    tombstones.delete(docId)
    const l = randomLevel()

    const node: HNSWNode = {
      docId,
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
      const heap = searchLayer(vecEntry.vector, vecEntry.magnitude, currentEPs, 1, layer, metric, false)
      const nearest = nearestFromHeap(heap)
      if (nearest) {
        currentEPs = [nearest.docId]
      }
    }

    for (let layer = Math.min(l, topLayer); layer >= 0; layer--) {
      const heap = searchLayer(vecEntry.vector, vecEntry.magnitude, currentEPs, efCons, layer, metric, false)
      const candidates = heap.toSortedArray().reverse()
      const mc = maxConns(layer)
      const neighbors = selectNeighborsHeuristic(docId, candidates, mc, layer, metric, false, true)

      for (const neighbor of neighbors) {
        node.connections[layer].add(neighbor.docId)
        const neighborNode = nodes.get(neighbor.docId)
        if (neighborNode && layer < neighborNode.connections.length) {
          neighborNode.connections[layer].add(docId)
          pruneConnections(neighbor.docId, neighborNode, layer, metric)
        }
      }

      if (candidates.length > 0) {
        currentEPs = candidates.map(n => n.docId)
      }
    }

    if (l > topLayer) {
      entryPointId = docId
      topLayer = l
    }
  }

  function removeNodeEager(docId: string, excludeDocIds?: Set<string>): void {
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
            if (excludeDocIds && excludeDocIds.has(otherId)) continue
            candidateIds.add(otherId)
          }
        }

        const candidates: DistancePair[] = []
        for (const candId of candidateIds) {
          const dist = nodeDistance(neighborId, candId, metric)
          if (dist === Number.POSITIVE_INFINITY) continue
          candidates.push({ docId: candId, distance: dist })
        }

        const selected = selectNeighborsHeuristic(neighborId, candidates, mc, layer, metric, false, true)
        const newConns = new Set(selected.map(s => s.docId))
        neighborNode.connections[layer] = newConns

        for (const newConnId of newConns) {
          const newConnNode = nodes.get(newConnId)
          if (newConnNode && layer < newConnNode.connections.length) {
            newConnNode.connections[layer].add(neighborId)
            pruneConnections(newConnId, newConnNode, layer, metric)
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
        if (tombstones.has(nId)) continue
        if (n.maxLayer > newTopLayer) {
          newTopLayer = n.maxLayer
          newEntryId = nId
        }
      }
      if (newEntryId === null) {
        for (const [nId, n] of nodes) {
          if (n.maxLayer > newTopLayer) {
            newTopLayer = n.maxLayer
            newEntryId = nId
          }
        }
      }
      entryPointId = newEntryId
      topLayer = newTopLayer
    }
  }

  function markTombstone(docId: string): void {
    if (!nodes.has(docId)) return
    tombstones.add(docId)

    if (entryPointId === docId) {
      let newEntryId: string | null = null
      let newTopLayer = -1
      for (const [nId, n] of nodes) {
        if (tombstones.has(nId)) continue
        if (n.maxLayer > newTopLayer) {
          newTopLayer = n.maxLayer
          newEntryId = nId
        }
      }
      if (newEntryId !== null) {
        entryPointId = newEntryId
        topLayer = newTopLayer
      } else {
        entryPointId = null
        topLayer = -1
      }
    }
  }

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

    const liveSize = nodes.size - tombstones.size
    if (entryPointId === null || liveSize === 0) {
      return []
    }

    const useQuantized = quantizer?.isCalibrated() === true && quantizer.size > 0
    const defaultEf = 50
    let ef = Math.max(efSearch ?? defaultEf, k)
    if (filterDocIds && filterDocIds.size < liveSize) {
      const selectivity = filterDocIds.size / liveSize
      ef = Math.max(ef, Math.ceil(k / Math.max(selectivity, 0.01)))
      ef = Math.min(ef, liveSize)
    }

    const qMag = magnitude(query)

    let quantizedDistFn: ((nodeId: string) => number) | undefined
    let prepared: QuantizedQuery | null = null
    if (useQuantized && quantizer) {
      prepared = quantizer.prepareQuery(query)
      if (prepared) {
        const p = prepared
        const metric = searchMetric
        const q = quantizer
        quantizedDistFn = (nodeId: string) => q.distanceFromPrepared(p, nodeId, metric)
      }
    }

    let currentEPs = [entryPointId]

    for (let layer = topLayer; layer >= 1; layer--) {
      const heap = searchLayer(query, qMag, currentEPs, 1, layer, searchMetric, true, quantizedDistFn)
      const nearest = nearestFromHeap(heap)
      if (nearest) {
        currentEPs = [nearest.docId]
      }
    }

    const candidateHeap = searchLayer(query, qMag, currentEPs, ef, 0, searchMetric, true, quantizedDistFn)
    const candidateArray = candidateHeap.toSortedArray().reverse()

    if (useQuantized) {
      return rerankWithFullPrecision(candidateArray, query, qMag, k, searchMetric, minSimilarity, filterDocIds)
    }

    const results: ScoredDocument[] = []
    for (const cand of candidateArray) {
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

    results.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
    return results.slice(0, k)
  }

  function rerankWithFullPrecision(
    candidates: DistancePair[],
    query: Float32Array,
    qMag: number,
    k: number,
    metric: VectorMetric,
    minSimilarity: number,
    filterDocIds?: Set<string>,
  ): ScoredDocument[] {
    const reranked: ScoredDocument[] = []
    const rerankLimit = Math.max(k * SQ8_OVERSELECTION_FACTOR, 10)

    for (const cand of candidates) {
      if (filterDocIds && !filterDocIds.has(cand.docId)) continue

      const entry = getEntry(cand.docId)
      if (!entry) continue

      const fullDistance = toDistance(query, entry.vector, qMag, entry.magnitude, metric)
      const score = toScore(fullDistance, metric)
      if (score < minSimilarity) continue

      reranked.push({
        docId: cand.docId,
        score,
        termFrequencies: {},
        fieldLengths: {},
        idf: {},
      })

      if (reranked.length >= rerankLimit) break
    }

    reranked.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
    return reranked.slice(0, k)
  }

  function serialize(): SerializedHNSWGraph {
    const nodeArray: Array<[string, number, Array<[number, string[]]>]> = []
    for (const [docId, node] of nodes) {
      if (tombstones.has(docId)) continue
      const layerConns: Array<[number, string[]]> = []
      for (let layer = 0; layer < node.connections.length; layer++) {
        const liveNeighbors = Array.from(node.connections[layer]).filter(id => !tombstones.has(id))
        if (liveNeighbors.length > 0) {
          layerConns.push([layer, liveNeighbors])
        }
      }
      nodeArray.push([docId, node.maxLayer, layerConns])
    }
    return {
      entryPoint: entryPointId,
      maxLayer: topLayer,
      m: M,
      efConstruction: efCons,
      metric: buildMetric,
      nodes: nodeArray,
    }
  }

  function deserialize(data: SerializedHNSWGraph): void {
    nodes.clear()
    tombstones.clear()

    for (const [docId, maxLayer, layerConns] of data.nodes) {
      const vecData = store.get(docId)
      if (!vecData) continue

      const connections: Set<string>[] = Array.from({ length: maxLayer + 1 }, () => new Set<string>())
      for (const [layer, neighbors] of layerConns) {
        if (layer < connections.length) {
          connections[layer] = new Set(neighbors)
        }
      }

      nodes.set(docId, { docId, maxLayer, connections })
    }

    if (data.entryPoint != null && data.entryPoint !== '' && nodes.has(data.entryPoint)) {
      entryPointId = data.entryPoint
      topLayer = data.maxLayer
    } else if (nodes.size > 0) {
      let bestId: string | null = null
      let bestLayer = -1
      for (const [nId, n] of nodes) {
        if (n.maxLayer > bestLayer) {
          bestLayer = n.maxLayer
          bestId = nId
        }
      }
      entryPointId = bestId
      topLayer = bestLayer
    } else {
      entryPointId = null
      topLayer = -1
    }
  }

  function clear(): void {
    nodes.clear()
    tombstones.clear()
    entryPointId = null
    topLayer = -1
  }

  function* entriesIterator(): IterableIterator<[string, VectorEntry]> {
    for (const [docId] of nodes) {
      if (tombstones.has(docId)) continue
      const entry = store.get(docId)
      if (!entry) continue
      yield [docId, { docId, vector: entry.vector, magnitude: entry.magnitude }]
    }
  }

  function compactionNeeded(): boolean {
    if (nodes.size === 0) return false
    return tombstones.size / nodes.size > COMPACTION_TOMBSTONE_RATIO || tombstones.size > COMPACTION_ABSOLUTE_THRESHOLD
  }

  function compactTombstones(): void {
    if (tombstones.size === 0) return

    const tombstonedDocIds = Array.from(tombstones)

    for (const docId of tombstonedDocIds) {
      removeNodeEager(docId, tombstones)
    }

    tombstones.clear()
  }

  function rebuild(): void {
    if (tombstones.size === 0 && nodes.size === 0) return

    const liveDocIds: string[] = []
    for (const [docId] of nodes) {
      if (!tombstones.has(docId)) {
        liveDocIds.push(docId)
      }
    }

    clear()

    for (const docId of liveDocIds) {
      const entry = store.get(docId)
      if (!entry) continue
      insertNode(docId)
    }
  }

  return {
    get dimension() {
      return dimension
    },
    get size() {
      return nodes.size - tombstones.size
    },
    get tombstoneCount() {
      return tombstones.size
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
    insertNode,
    markTombstone,
    has: (docId: string) => nodes.has(docId) && !tombstones.has(docId),
    isTombstoned: (docId: string) => tombstones.has(docId),
    search,
    clear,
    entries: entriesIterator,
    compactionNeeded,
    compact: rebuild,
    compactTombstones,
    rebuild,
    serialize,
    deserialize,
  }
}
