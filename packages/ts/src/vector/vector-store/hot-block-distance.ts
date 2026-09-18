import type { VectorMetric } from '../brute-force'
import { arenaFloat32Distance } from '../simd'
import { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance } from '../similarity'
import { type OpenVectorBlock, QUERY_STAGED } from './blocks'
import { IN_MEMORY } from './handles'
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

function inMemory(reads: HotBlockReads, ordinal: number): boolean {
  return ordinal >= 0 && ordinal < reads.limit && reads.diskFile[ordinal] === IN_MEMORY
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
  const scratchOffset = block.scratchByteOffset
  const queryMagnitude = prepared.magnitude
  return ordinal => {
    if (!inMemory(reads, ordinal) || block.stagedOrdinal !== QUERY_STAGED) return generic(ordinal)
    if (present[ordinal] !== 1) return Number.POSITIVE_INFINITY
    const slotOffset = slotsOffset + ordinal * slotStride
    return arenaFloat32Distance(simd, scratchOffset, slotOffset, dimension, metric, queryMagnitude, magnitudes[ordinal])
  }
}

export function pairDistanceOf(source: HotBlockSource, metric: VectorMetric): (ordA: number, ordB: number) => number {
  const generic = (ordA: number, ordB: number): number => source.distanceByOrdinal(ordA, ordB, metric)
  const reads = source.hotBlockReads()
  const simd = reads?.block.simd ?? null
  if (reads === null || simd === null) return generic
  const { present, magnitudes, slotsOffset, slotStride, dimension } = reads
  return (ordA, ordB) => {
    if (!inMemory(reads, ordA) || !inMemory(reads, ordB) || present[ordA] !== 1) return generic(ordA, ordB)
    if (present[ordB] !== 1) return Number.POSITIVE_INFINITY
    const offsetA = slotsOffset + ordA * slotStride
    const offsetB = slotsOffset + ordB * slotStride
    return arenaFloat32Distance(simd, offsetA, offsetB, dimension, metric, magnitudes[ordA], magnitudes[ordB])
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
