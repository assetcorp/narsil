import {
  arenaFloat32Distance,
  cosineSimilarityWithMagnitudes,
  dotProduct,
  euclideanDistance,
  IN_MEMORY,
  QUERY_STAGED,
} from '#platform/vector-host'
import type { VectorMetric } from '../brute-force'
import type { OpenVectorBlock } from './blocks'
import type { ArenaQueryVector } from './types'

export interface HotBlockReads {
  block: OpenVectorBlock
  present: Uint8Array
  diskFile: Int32Array
  magnitudes: Float64Array
  limit: number
  slotsOffset: number
  slotStride: number
  dimension: number
}

interface HotBlockSource {
  hotBlockReads(): HotBlockReads | null
  distanceFromArena(prepared: ArenaQueryVector, ordinal: number, metric: VectorMetric): number
  distanceByOrdinal(ordA: number, ordB: number, metric: VectorMetric): number
}

export function jsDistance(a: Float32Array, b: Float32Array, magA: number, magB: number, metric: VectorMetric): number {
  switch (metric) {
    case 'cosine':
      return 1 - cosineSimilarityWithMagnitudes(a, b, magA, magB)
    case 'dotProduct':
      return -dotProduct(a, b)
    case 'euclidean':
      return euclideanDistance(a, b)
  }
}

interface HeldVectorReads {
  holdsOrdinal(ordinal: number): boolean
  isCold(ordinal: number): boolean
  readColdInto(ordinal: number, target: Float32Array): boolean
  vectorAt(ordinal: number): Float32Array
  magnitudeAt(ordinal: number): number
}

export function distanceFromQueryOf(
  source: HeldVectorReads,
  coldScratch: Float32Array,
  query: Float32Array,
  queryMagnitude: number,
  ordinal: number,
  metric: VectorMetric,
): number {
  if (!source.holdsOrdinal(ordinal)) return Number.POSITIVE_INFINITY
  const vector =
    source.isCold(ordinal) && source.readColdInto(ordinal, coldScratch) ? coldScratch : source.vectorAt(ordinal)
  return jsDistance(query, vector, queryMagnitude, source.magnitudeAt(ordinal), metric)
}

function inMemoryTest({ limit, diskFile }: HotBlockReads): (ordinal: number) => boolean {
  const inMemoryFile = IN_MEMORY
  return ordinal => ordinal >= 0 && ordinal < limit && diskFile[ordinal] === inMemoryFile
}

export function queryDistanceOf(
  source: HotBlockSource,
  prepared: ArenaQueryVector,
  metric: VectorMetric,
): (ordinal: number) => number {
  const generic = (ordinal: number): number => source.distanceFromArena(prepared, ordinal, metric)
  const reads = source.hotBlockReads()
  const simd = reads?.block.simd ?? null
  if (reads === null || simd === null || !reads.block.hasScratch) return generic
  const { block, present, magnitudes, slotsOffset, slotStride, dimension } = reads
  const inMemory = inMemoryTest(reads)
  const distance = arenaFloat32Distance
  const queryStaged = QUERY_STAGED
  const scratchOffset = block.scratchByteOffset
  const queryMagnitude = prepared.magnitude
  return ordinal => {
    if (!inMemory(ordinal) || block.stagedOrdinal !== queryStaged) return generic(ordinal)
    if (present[ordinal] !== 1) return Number.POSITIVE_INFINITY
    const slotOffset = slotsOffset + ordinal * slotStride
    return distance(simd, scratchOffset, slotOffset, dimension, metric, queryMagnitude, magnitudes[ordinal])
  }
}

export function pairDistanceOf(source: HotBlockSource, metric: VectorMetric): (ordA: number, ordB: number) => number {
  const generic = (ordA: number, ordB: number): number => source.distanceByOrdinal(ordA, ordB, metric)
  const reads = source.hotBlockReads()
  const simd = reads?.block.simd ?? null
  if (reads === null || simd === null) return generic
  const { present, magnitudes, slotsOffset, slotStride, dimension } = reads
  const inMemory = inMemoryTest(reads)
  const distance = arenaFloat32Distance
  return (ordA, ordB) => {
    if (!inMemory(ordA) || !inMemory(ordB) || present[ordA] !== 1) return generic(ordA, ordB)
    if (present[ordB] !== 1) return Number.POSITIVE_INFINITY
    const offsetA = slotsOffset + ordA * slotStride
    const offsetB = slotsOffset + ordB * slotStride
    return distance(simd, offsetA, offsetB, dimension, metric, magnitudes[ordA], magnitudes[ordB])
  }
}

export function ordinalDistanceOf(
  source: HotBlockSource,
  from: number,
  metric: VectorMetric,
): (ordinal: number) => number {
  const pair = pairDistanceOf(source, metric)
  return ordinal => pair(from, ordinal)
}
