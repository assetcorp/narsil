import { compareCodePoints } from '../../core/ordering'
import type { SearchClock } from '../../core/search-clock'
import type { VectorMetric } from '../../vector/brute-force'
import { toDistance, toScore } from '../../vector/hnsw/shared'
import { osqDistance, osqEstimate } from '../../vector/osq/estimate'
import { scalarQueryProducts } from '../../vector/osq/products'
import { createOsqScratch, osqQuantize } from '../../vector/osq/quantize'
import { type OsqTrailer, readTrailer, stageQueryLevels } from '../../vector/osq/record'
import { defaultEfSearch, defaultRescoreDepth } from '../../vector/search-depth'
import { magnitude } from '../../vector/similarity'
import type { VectorScoredResult } from '../../vector/vector-index/shared'
import { computeCodeBlockLayout } from '../../vector/vector-store/code-blocks'
import { COLD_GRAPH_PART_VECTORS, type ColdFieldData } from './cold-field'
import { COLD_WALK_NODES_READ_AHEAD } from './constants'
import { loadFailed } from './format'

export interface ColdSearchOptions {
  metric: VectorMetric
  minSimilarity: number
  efSearch?: number
  oversample?: number
  rescoreWindow?: number
  clock?: SearchClock
}

interface MinHeap {
  numbers: number[]
  distances: number[]
}

function pushMin(heap: MinHeap, number: number, distance: number): void {
  let at = heap.numbers.length
  heap.numbers.push(number)
  heap.distances.push(distance)
  while (at > 0) {
    const parent = (at - 1) >> 1
    if (heap.distances[parent] <= distance) break
    heap.numbers[at] = heap.numbers[parent]
    heap.distances[at] = heap.distances[parent]
    at = parent
  }
  heap.numbers[at] = number
  heap.distances[at] = distance
}

function popMin(heap: MinHeap): { number: number; distance: number } | null {
  const size = heap.numbers.length
  if (size === 0) return null
  const top = { number: heap.numbers[0], distance: heap.distances[0] }
  const number = heap.numbers[size - 1]
  const distance = heap.distances[size - 1]
  heap.numbers.pop()
  heap.distances.pop()
  const remaining = size - 1
  if (remaining === 0) return top
  let at = 0
  for (;;) {
    let child = 2 * at + 1
    if (child >= remaining) break
    if (child + 1 < remaining && heap.distances[child + 1] < heap.distances[child]) child += 1
    if (heap.distances[child] >= distance) break
    heap.numbers[at] = heap.numbers[child]
    heap.distances[at] = heap.distances[child]
    at = child
  }
  heap.numbers[at] = number
  heap.distances[at] = distance
  return top
}

function negated(heap: MinHeap): number {
  return heap.distances.length === 0 ? Number.POSITIVE_INFINITY : -heap.distances[0]
}

function neighbourList(
  data: ColdFieldData,
  number: number,
  layer: number,
): { view: DataView; count: number; at: number } {
  const part = data.parts[Math.floor(number / COLD_GRAPH_PART_VECTORS)]
  const offset = number % COLD_GRAPH_PART_VECTORS
  const start = part.nodeOffsets[offset]
  const end = part.nodeOffsets[offset + 1]
  const bytes = part.neighbours.bytesAt(start, end - start)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let cursor = 0
  for (let current = 0; ; current++) {
    if (cursor + 4 > bytes.byteLength) loadFailed(`The neighbour lists of vector ${number} end inside a list`)
    const count = view.getUint32(cursor, true)
    if (cursor + 4 + count * 4 > bytes.byteLength)
      loadFailed(`The neighbour list of vector ${number} runs past its node`)
    if (current === layer) return { view, count, at: cursor + 4 }
    cursor += 4 + count * 4
  }
}

interface WalkScope {
  data: ColdFieldData
  distanceOf(number: number): number
  isAccepted(number: number): boolean
  visited: Uint8Array
  clock: SearchClock | undefined
  fetchesRows: boolean
  fetchDistanceRows(numbers: readonly number[]): Promise<unknown> | null
}

function fetchNeighbourLists(data: ColdFieldData, numbers: readonly number[]): Promise<unknown> | null {
  const reads: Array<Promise<unknown>> = []
  for (const number of numbers) {
    const part = data.parts[Math.floor(number / COLD_GRAPH_PART_VECTORS)]
    const offset = number % COLD_GRAPH_PART_VECTORS
    const start = part.nodeOffsets[offset]
    const size = part.nodeOffsets[offset + 1] - start
    if (size === 0) continue
    const read = part.neighbours.fetchRows([start], size)
    if (read !== null) reads.push(read)
  }
  return reads.length === 0 ? null : Promise.all(reads)
}

function unseenNeighbours(scope: WalkScope, numbers: readonly number[], layer: number): number[] {
  const unseen = new Set<number>()
  for (const number of numbers) {
    const list = neighbourList(scope.data, number, layer)
    for (let at = 0; at < list.count; at++) {
      const neighbour = list.view.getUint32(list.at + at * 4, true)
      if (neighbour < scope.data.total && scope.visited[neighbour] === 0) unseen.add(neighbour)
    }
  }
  return [...unseen]
}

function* readTheWalkAhead(
  scope: WalkScope,
  next: number,
  frontier: MinHeap,
  layer: number,
): Generator<Promise<unknown>, void> {
  const { data } = scope
  const listOfNext = fetchNeighbourLists(data, [next])
  const rowsOfNext = listOfNext === null ? scope.fetchDistanceRows(unseenNeighbours(scope, [next], layer)) : null
  if (listOfNext === null && rowsOfNext === null) return
  const others = frontier.numbers.slice(0, COLD_WALK_NODES_READ_AHEAD - 1)
  yield Promise.all([listOfNext, rowsOfNext, fetchNeighbourLists(data, others)])
  const rows = scope.fetchDistanceRows(unseenNeighbours(scope, [next, ...others], layer))
  if (rows !== null) yield rows
}

function* walkLayer(
  scope: WalkScope,
  entries: readonly number[],
  ef: number,
  layer: number,
  excludes: boolean,
): Generator<Promise<unknown>, MinHeap> {
  const { data, distanceOf, isAccepted } = scope
  const visited = scope.visited
  visited.fill(0)
  const frontier: MinHeap = { numbers: [], distances: [] }
  const found: MinHeap = { numbers: [], distances: [] }

  function take(number: number, distance: number): void {
    pushMin(found, number, -distance)
    if (found.numbers.length > ef) popMin(found)
  }

  for (const entry of entries) {
    if (visited[entry] === 1) continue
    visited[entry] = 1
    if (data.topLayerOf(entry) < layer) continue
    const distance = distanceOf(entry)
    if (distance === Number.POSITIVE_INFINITY) continue
    pushMin(frontier, entry, distance)
    if (excludes && !isAccepted(entry)) continue
    take(entry, distance)
  }
  let furthest = found.numbers.length > 0 ? negated(found) : Number.POSITIVE_INFINITY

  for (;;) {
    const next = popMin(frontier)
    if (next === null) break
    if (next.distance > furthest && found.numbers.length >= ef) break
    if (scope.fetchesRows) yield* readTheWalkAhead(scope, next.number, frontier, layer)
    const list = neighbourList(data, next.number, layer)
    scope.clock?.tick(list.count * data.dimension)
    for (let at = 0; at < list.count; at++) {
      const neighbour = list.view.getUint32(list.at + at * 4, true)
      if (neighbour >= data.total || visited[neighbour] === 1) continue
      visited[neighbour] = 1
      if (data.topLayerOf(neighbour) < layer) continue
      const distance = distanceOf(neighbour)
      if (distance === Number.POSITIVE_INFINITY) continue
      if (distance < furthest || found.numbers.length < ef) {
        pushMin(frontier, neighbour, distance)
        if (excludes && !isAccepted(neighbour)) continue
        take(neighbour, distance)
        furthest = negated(found)
      }
    }
  }
  return found
}

function nearestFirst(found: MinHeap): { numbers: number[]; distances: number[] } {
  const numbers: number[] = []
  const distances: number[] = []
  for (;;) {
    const top = popMin(found)
    if (top === null) break
    numbers.push(top.number)
    distances.push(-top.distance)
  }
  numbers.reverse()
  distances.reverse()
  return { numbers, distances }
}

function entryNumberOf(data: ColdFieldData): number | null {
  const { entryPoint } = data.graph
  if (entryPoint !== null && data.topLayerOf(entryPoint) >= 0) return entryPoint
  let best: number | null = null
  let bestTop = -1
  for (let number = 0; number < data.total; number++) {
    const top = data.topLayerOf(number)
    if (top > bestTop) {
      bestTop = top
      best = number
    }
  }
  return best
}

function codeDistance(data: ColdFieldData, query: Float32Array, metric: VectorMetric): ((n: number) => number) | null {
  const { codes, dimension } = data
  if (codes === null) return null
  const layout = computeCodeBlockLayout(dimension, codes.bits)
  const code = osqQuantize(query, codes.centroid, layout.queryBits, metric, createOsqScratch(dimension))
  const packed = new Uint8Array(layout.queryBytes)
  stageQueryLevels(code.levels, codes.bits, packed)
  let centroidDot = 0
  for (let at = 0; at < dimension; at++) centroidDot += codes.centroid[at] * codes.centroid[at]
  const trailer: OsqTrailer = { lower: 0, upper: 0, correction: 0, sum: 0 }
  const { codeBytes, slotStride, queryBits, bits } = layout
  return number => {
    const file = data.fileOfNumber(number)
    if (file.records === null) return Number.POSITIVE_INFINITY
    const record = file.records.bytesAt((number - file.firstNumber) * slotStride, slotStride)
    const products = scalarQueryProducts(layout, record, 0, packed)
    readTrailer(new DataView(record.buffer, record.byteOffset, record.byteLength), 0, codeBytes, trailer)
    const estimate = osqEstimate(products, trailer, bits, code, queryBits, dimension, centroidDot, metric)
    return osqDistance(estimate, metric)
  }
}

interface ScoredNumber {
  number: number
  score: number
}

function numbersThatCanReachTheTop(scored: ScoredNumber[], k: number): ScoredNumber[] {
  if (k <= 0 || scored.length <= k) return scored
  scored.sort((a, b) => b.score - a.score)
  const lowestKept = scored[k - 1].score
  let end = k
  while (end < scored.length && scored[end].score === lowestKept) end += 1
  return scored.slice(0, end)
}

function bestHits(hits: VectorScoredResult[], k: number): VectorScoredResult[] {
  return hits.sort((a, b) => b.score - a.score || compareCodePoints(a.docId, b.docId)).slice(0, Math.max(k, 0))
}

export function searchColdGraph(
  data: ColdFieldData,
  query: Float32Array,
  k: number,
  options: ColdSearchOptions,
  accepts: ((docId: string) => boolean) | null,
  excluded: ReadonlySet<number>,
): VectorScoredResult[] {
  const walk = walkColdGraph(data, query, k, options, accepts, excluded, false)
  let step = walk.next()
  while (step.done !== true) step = walk.next()
  return step.value
}

export async function searchColdGraphConcurrently(
  data: ColdFieldData,
  query: Float32Array,
  k: number,
  options: ColdSearchOptions,
  accepts: ((docId: string) => boolean) | null,
  excluded: ReadonlySet<number>,
): Promise<VectorScoredResult[]> {
  const walk = walkColdGraph(data, query, k, options, accepts, excluded, true)
  let step = walk.next()
  while (step.done !== true) {
    await step.value
    step = walk.next()
  }
  return step.value
}

function* walkColdGraph(
  data: ColdFieldData,
  query: Float32Array,
  k: number,
  options: ColdSearchOptions,
  accepts: ((docId: string) => boolean) | null,
  excluded: ReadonlySet<number>,
  fetchesRows: boolean,
): Generator<Promise<unknown>, VectorScoredResult[]> {
  const { metric, minSimilarity } = options
  const entry = entryNumberOf(data)
  if (entry === null) return []
  const qMag = magnitude(query)
  const fromCodes = codeDistance(data, query, metric)
  const fullDistance = (number: number): number =>
    toDistance(query, data.vectorAt(number), qMag, data.magnitudeAt(number), metric)
  const distanceOf = fromCodes ?? fullDistance
  const acceptance = new Map<number, boolean>()
  const isAccepted = (number: number): boolean => {
    if (excluded.has(number) || data.isDeadNumber(number)) return false
    if (accepts === null) return true
    const held = acceptance.get(number)
    if (held !== undefined) return held
    const accepted = accepts(data.idAt(number))
    acceptance.set(number, accepted)
    return accepted
  }

  const window = options.rescoreWindow ?? k
  const codes = data.codes
  let depth = window
  if (codes !== null) {
    depth =
      options.oversample === undefined
        ? defaultRescoreDepth(codes.bits, data.dimension, window)
        : Math.ceil(window * options.oversample)
  }
  const ef = Math.max(options.efSearch ?? defaultEfSearch(data.dimension, window), depth)
  const codeRowBytes = codes === null ? null : computeCodeBlockLayout(data.dimension, codes.bits).slotStride
  const scope: WalkScope = {
    data,
    distanceOf,
    isAccepted,
    visited: new Uint8Array(data.total),
    clock: options.clock,
    fetchesRows,
    fetchDistanceRows: numbers =>
      codeRowBytes === null ? fetchVectorRows(numbers) : data.fetchRows(numbers, file => file.records, codeRowBytes),
  }

  function fetchVectorRows(numbers: readonly number[]): Promise<unknown> | null {
    return data.fetchRows(numbers, file => file.vectors, data.dimension * 4)
  }

  let current = entry
  for (let layer = Math.min(data.graph.maxLayer, data.topLayerOf(entry)); layer >= 1; layer--) {
    const { numbers } = nearestFirst(yield* walkLayer(scope, [current], 1, layer, false))
    if (numbers.length > 0) current = numbers[0]
  }
  const { numbers, distances } = nearestFirst(yield* walkLayer(scope, [current], ef, 0, true))

  const scored: ScoredNumber[] = []
  const rescores = codes !== null
  const rescoreUntil = rescores ? Math.min(depth, numbers.length) : 0
  if (fetchesRows && rescoreUntil > 0) {
    const reading = fetchVectorRows(numbers.slice(0, rescoreUntil))
    if (reading !== null) yield reading
  }
  for (let at = 0; at < numbers.length; at++) {
    const number = numbers[at]
    if (
      rescores &&
      at >= rescoreUntil &&
      (options.rescoreWindow === undefined || minSimilarity !== Number.NEGATIVE_INFINITY)
    ) {
      break
    }
    const distance = at < rescoreUntil ? fullDistance(number) : distances[at]
    const score = toScore(distance, metric)
    if (score < minSimilarity) continue
    scored.push({ number, score })
  }
  const hits = numbersThatCanReachTheTop(scored, k).map(({ number, score }) => ({ docId: data.idAt(number), score }))
  return bestHits(hits, k)
}
