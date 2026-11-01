import { createBoundedMaxHeap } from '../../core/heap'
import type { VectorMetric } from '../brute-force'
import type { FilterSubset } from '../filter-ordinals'
import { toDistance, toScore } from '../hnsw/shared'
import { magnitude } from '../similarity'
import { beginCheckpointRestore, type CheckpointRestoreShape, type VectorCheckpointRestore } from './checkpoint-restore'
import { highScoreFirst, mergeResults } from './merge-results'
import type {
  ColdVectorField,
  VectorIndexState,
  VectorScoredResult,
  VectorSearchOptions,
  VectorSearchOutcome,
} from './shared'

export interface ColdVectorHold {
  readonly field: ColdVectorField
  readonly loaded: Promise<void>
  readonly written: Map<string, { vector: Float32Array; partitionId: number | undefined }>
  readonly removedNumbers: Set<number>
  readonly removedIds: Set<string>
  readonly writes: Array<() => void>
  live: number
}

export type ColdFieldLoad = (
  beginRestore: (shape: CheckpointRestoreShape) => VectorCheckpointRestore,
  stillWanted: () => boolean,
) => Promise<void>

export function beginColdHold(state: VectorIndexState, field: ColdVectorField, loaded: Promise<void>): ColdVectorHold {
  const hold: ColdVectorHold = {
    field,
    loaded,
    written: new Map(),
    removedNumbers: new Set(),
    removedIds: new Set(),
    writes: [],
    live: field.liveCount,
  }
  state.cold = hold
  return hold
}

export function endColdHold(state: VectorIndexState): void {
  const hold = state.cold
  if (hold === null) return
  state.cold = null
  for (const write of hold.writes) write()
  hold.field.close()
}

export function cancelColdHold(state: VectorIndexState): void {
  const hold = state.cold
  if (hold === null) return
  state.cold = null
  hold.field.close()
}

export function openColdField(state: VectorIndexState, field: ColdVectorField, load: ColdFieldLoad): void {
  cancelColdHold(state)
  let finished: () => void = () => undefined
  let failed: (error: unknown) => void = () => undefined
  const loaded = new Promise<void>((resolve, reject) => {
    finished = resolve
    failed = reject
  })
  const hold = beginColdHold(state, field, loaded)
  void load(
    shape => beginCheckpointRestore(state, shape),
    () => state.cold === hold,
  ).then(
    () => {
      if (state.cold === hold) endColdHold(state)
      finished()
    },
    error => failed(error),
  )
  loaded.catch(() => undefined)
}

function retireOlderCopy(hold: ColdVectorHold, docId: string): boolean {
  if (hold.written.delete(docId)) return true
  if (hold.removedIds.has(docId)) return false
  const number = hold.field.numberOf(docId)
  if (number === undefined) return false
  hold.removedIds.add(docId)
  hold.removedNumbers.add(number)
  return true
}

export function coldInsert(
  hold: ColdVectorHold,
  docId: string,
  vector: Float32Array,
  partitionId: number | undefined,
): boolean {
  const replaced = retireOlderCopy(hold, docId)
  if (!replaced) hold.live += 1
  hold.written.set(docId, { vector: vector.slice(), partitionId })
  return replaced
}

export function coldRemove(hold: ColdVectorHold, docId: string): boolean {
  const removed = retireOlderCopy(hold, docId)
  if (removed) hold.live -= 1
  return removed
}

export function coldHas(hold: ColdVectorHold, docId: string): boolean {
  if (hold.written.has(docId)) return true
  if (hold.removedIds.has(docId)) return false
  return hold.field.numberOf(docId) !== undefined
}

export function coldVectorOf(hold: ColdVectorHold, docId: string): Float32Array | null {
  const written = hold.written.get(docId)
  if (written !== undefined) return written.vector.slice()
  if (hold.removedIds.has(docId)) return null
  const number = hold.field.numberOf(docId)
  return number === undefined ? null : hold.field.vectorOfNumber(number)
}

function isAdmitted(subsets: readonly FilterSubset[], docId: string): boolean {
  for (const subset of subsets) {
    const { docStore } = subset.owner
    if (docStore.numberingGeneration() !== subset.numberingGeneration) continue
    const internalId = docStore.getInternalId(docId)
    if (internalId === undefined) continue
    const word = subset.bits[internalId >>> 5]
    if (word !== undefined && (word & (1 << (internalId & 31))) !== 0 && docStore.resolver().isLive(internalId)) {
      return true
    }
  }
  return false
}

function admissionOf(options: VectorSearchOptions, hold: ColdVectorHold): ((docId: string) => boolean) | null {
  const { filterSubsets, filterPartitions } = options
  if (filterSubsets !== undefined) return docId => isAdmitted(filterSubsets, docId)
  if (filterPartitions !== undefined) {
    return docId => {
      const partition = hold.field.partitionOf(docId)
      return partition !== undefined && filterPartitions.has(partition)
    }
  }
  return null
}

function bitCount(word: number): number {
  let value = word - ((word >>> 1) & 0x55555555)
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333)
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

function admittedBySubsets(subsets: readonly FilterSubset[]): number {
  let admitted = 0
  for (const subset of subsets) {
    for (let at = 0; at < subset.bits.length; at++) admitted += bitCount(subset.bits[at])
  }
  return admitted
}

function* idsOfSubsets(subsets: readonly FilterSubset[]): Iterable<string> {
  for (const subset of subsets) {
    const { bits } = subset
    const { docStore } = subset.owner
    if (docStore.numberingGeneration() !== subset.numberingGeneration) continue
    for (let wordIndex = 0; wordIndex < bits.length; wordIndex++) {
      let word = bits[wordIndex]
      while (word !== 0) {
        const internalId = (wordIndex << 5) + (Math.clz32(word & -word) ^ 31)
        word &= word - 1
        if (!docStore.resolver().isLive(internalId)) continue
        const docId = docStore.getExternalId(internalId)
        if (docId !== undefined) yield docId
      }
    }
  }
}

function scoreOf(
  query: Float32Array,
  qMag: number,
  vector: Float32Array,
  vectorMagnitude: number,
  metric: VectorMetric,
): number {
  return toScore(toDistance(query, vector, qMag, vectorMagnitude, metric), metric)
}

function scanWritten(
  hold: ColdVectorHold,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  admits: ((docId: string) => boolean) | null,
): VectorScoredResult[] {
  if (hold.written.size === 0) return []
  const qMag = magnitude(query)
  const heap = createBoundedMaxHeap<VectorScoredResult>(highScoreFirst, Math.max(k, 1))
  for (const [docId, { vector }] of hold.written) {
    if (admits !== null && !admits(docId)) continue
    const score = scoreOf(query, qMag, vector, magnitude(vector), options.metric)
    if (score >= options.minSimilarity) heap.push({ docId, score })
  }
  return heap.toSortedArray().reverse()
}

function scanSubsets(
  hold: ColdVectorHold,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
  subsets: readonly FilterSubset[],
): { results: VectorScoredResult[]; matched: number } {
  const qMag = magnitude(query)
  const heap = createBoundedMaxHeap<VectorScoredResult>(highScoreFirst, Math.max(k, 1))
  let matched = 0
  for (const docId of idsOfSubsets(subsets)) {
    const written = hold.written.get(docId)
    let score: number
    if (written !== undefined) {
      score = scoreOf(query, qMag, written.vector, magnitude(written.vector), options.metric)
    } else {
      if (hold.removedIds.has(docId)) continue
      const number = hold.field.numberOf(docId)
      if (number === undefined) continue
      const vector = hold.field.vectorOfNumber(number)
      score = scoreOf(query, qMag, vector, hold.field.magnitudeOfNumber(number), options.metric)
    }
    if (score < options.minSimilarity) continue
    matched += 1
    heap.push({ docId, score })
  }
  return { results: heap.toSortedArray().reverse(), matched }
}

interface ColdGraphWalk {
  admits: ((docId: string) => boolean) | null
  admitted: number
}

function outcomeWithoutGraphWalk(
  state: VectorIndexState,
  hold: ColdVectorHold,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
): VectorSearchOutcome | ColdGraphWalk {
  if (hold.live === 0) return { results: [], matched: 0, matchedExact: true }
  const subsets = options.filterSubsets
  let admitted = hold.live
  if (subsets !== undefined) {
    admitted = admittedBySubsets(subsets)
    if (admitted === 0) return { results: [], matched: 0, matchedExact: true }
    if (admitted / hold.live < state.filterThreshold) {
      const { results, matched } = scanSubsets(hold, query, k, options, subsets)
      return { results: results.slice(0, Math.max(k, 0)), matched, matchedExact: true }
    }
  }
  if (k <= 0) {
    return options.minSimilarity === Number.NEGATIVE_INFINITY
      ? { results: [], matched: admitted, matchedExact: true }
      : { results: [], matched: 0, matchedExact: false }
  }
  return { admits: admissionOf(options, hold), admitted }
}

function outcomeOfGraphWalk(
  hold: ColdVectorHold,
  walk: ColdGraphWalk,
  fromGraph: VectorScoredResult[],
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
): VectorSearchOutcome {
  const results = mergeResults(fromGraph, scanWritten(hold, query, k, options, walk.admits), k)
  return options.minSimilarity === Number.NEGATIVE_INFINITY
    ? { results, matched: walk.admitted, matchedExact: true }
    : { results, matched: results.length, matchedExact: false }
}

export function coldSearch(
  state: VectorIndexState,
  hold: ColdVectorHold,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
): VectorSearchOutcome {
  const walk = outcomeWithoutGraphWalk(state, hold, query, k, options)
  if ('results' in walk) return walk
  const fromGraph = hold.field.search(query, k, options, walk.admits, hold.removedNumbers)
  return outcomeOfGraphWalk(hold, walk, fromGraph, query, k, options)
}

export async function coldSearchConcurrently(
  state: VectorIndexState,
  hold: ColdVectorHold,
  query: Float32Array,
  k: number,
  options: VectorSearchOptions,
): Promise<VectorSearchOutcome> {
  const walk = outcomeWithoutGraphWalk(state, hold, query, k, options)
  if ('results' in walk) return walk
  const fromGraph = await hold.field.searchConcurrently(query, k, options, walk.admits, hold.removedNumbers)
  return outcomeOfGraphWalk(hold, walk, fromGraph, query, k, options)
}
