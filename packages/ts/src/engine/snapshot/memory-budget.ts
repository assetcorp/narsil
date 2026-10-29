import { readHeapStatistics } from '#platform/heap-statistics'
import { collectAndReturnPages } from '#platform/idle-heap-cleanup'
import { readResidentMemory } from '#platform/process-limit'
import { ErrorCodes, NarsilError } from '../../errors'
import type { SegmentManifest } from '../../persistence/durability/segment/manifest'
import { extractVectorFieldsFromSchema } from '../../schema/validator'
import {
  RESTORE_ESTIMATE_MARGIN,
  RESTORE_FLOOR_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_BYTE,
  RESTORE_FLOOR_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_VECTOR,
  RESTORE_FLOOR_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_VECTOR_DIMENSION,
  RESTORE_FLOOR_EXTERNAL_BYTES_PER_STORED_BYTE,
  RESTORE_FLOOR_EXTERNAL_BYTES_PER_VECTOR,
  RESTORE_FLOOR_EXTERNAL_BYTES_PER_VECTOR_DIMENSION,
  RESTORE_FLOOR_HEAP_BYTES_PER_EARLIER_SNAPSHOT_BYTE,
  RESTORE_FLOOR_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR,
  RESTORE_FLOOR_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR_DIMENSION,
  RESTORE_FLOOR_HEAP_BYTES_PER_STORED_BYTE,
  RESTORE_FLOOR_HEAP_BYTES_PER_VECTOR,
  RESTORE_FLOOR_HEAP_BYTES_PER_VECTOR_DIMENSION,
  RESTORE_WORST_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_BYTE,
  RESTORE_WORST_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_VECTOR,
  RESTORE_WORST_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_VECTOR_DIMENSION,
  RESTORE_WORST_EXTERNAL_BYTES_PER_STORED_BYTE,
  RESTORE_WORST_EXTERNAL_BYTES_PER_VECTOR,
  RESTORE_WORST_EXTERNAL_BYTES_PER_VECTOR_DIMENSION,
  RESTORE_WORST_HEAP_BYTES_PER_EARLIER_SNAPSHOT_BYTE,
  RESTORE_WORST_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR,
  RESTORE_WORST_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR_DIMENSION,
  RESTORE_WORST_HEAP_BYTES_PER_STORED_BYTE,
  RESTORE_WORST_HEAP_BYTES_PER_VECTOR,
  RESTORE_WORST_HEAP_BYTES_PER_VECTOR_DIMENSION,
} from './constants'
import type { PreparedIndex } from './restore-setup'

const MEGABYTE_BYTES = 1_048_576

export interface RestoreFootprint {
  heapBytes: number
  externalBytes: number
}

type MemoryBudget = 'heap' | 'process'

interface MemoryRate {
  perStoredByte: number
  perVector: number
  perVectorDimension: number
}

interface RestoreRates {
  heap: MemoryRate
  external: MemoryRate
}

interface PathRates {
  worst: RestoreRates
  floor: RestoreRates
}

const ARCHIVE_RATES: PathRates = {
  worst: {
    heap: {
      perStoredByte: RESTORE_WORST_HEAP_BYTES_PER_STORED_BYTE,
      perVector: RESTORE_WORST_HEAP_BYTES_PER_VECTOR,
      perVectorDimension: RESTORE_WORST_HEAP_BYTES_PER_VECTOR_DIMENSION,
    },
    external: {
      perStoredByte: RESTORE_WORST_EXTERNAL_BYTES_PER_STORED_BYTE,
      perVector: RESTORE_WORST_EXTERNAL_BYTES_PER_VECTOR,
      perVectorDimension: RESTORE_WORST_EXTERNAL_BYTES_PER_VECTOR_DIMENSION,
    },
  },
  floor: {
    heap: {
      perStoredByte: RESTORE_FLOOR_HEAP_BYTES_PER_STORED_BYTE,
      perVector: RESTORE_FLOOR_HEAP_BYTES_PER_VECTOR,
      perVectorDimension: RESTORE_FLOOR_HEAP_BYTES_PER_VECTOR_DIMENSION,
    },
    external: {
      perStoredByte: RESTORE_FLOOR_EXTERNAL_BYTES_PER_STORED_BYTE,
      perVector: RESTORE_FLOOR_EXTERNAL_BYTES_PER_VECTOR,
      perVectorDimension: RESTORE_FLOOR_EXTERNAL_BYTES_PER_VECTOR_DIMENSION,
    },
  },
}

const EARLIER_SNAPSHOT_RATES: PathRates = {
  worst: {
    heap: {
      perStoredByte: RESTORE_WORST_HEAP_BYTES_PER_EARLIER_SNAPSHOT_BYTE,
      perVector: RESTORE_WORST_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR,
      perVectorDimension: RESTORE_WORST_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR_DIMENSION,
    },
    external: {
      perStoredByte: RESTORE_WORST_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_BYTE,
      perVector: RESTORE_WORST_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_VECTOR,
      perVectorDimension: RESTORE_WORST_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_VECTOR_DIMENSION,
    },
  },
  floor: {
    heap: {
      perStoredByte: RESTORE_FLOOR_HEAP_BYTES_PER_EARLIER_SNAPSHOT_BYTE,
      perVector: RESTORE_FLOOR_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR,
      perVectorDimension: RESTORE_FLOOR_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR_DIMENSION,
    },
    external: {
      perStoredByte: RESTORE_FLOOR_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_BYTE,
      perVector: RESTORE_FLOOR_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_VECTOR,
      perVectorDimension: RESTORE_FLOOR_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_VECTOR_DIMENSION,
    },
  },
}

interface VectorCount {
  dimension: number
  count: number
}

function bytesAt(rate: MemoryRate, storedBytes: number, vectors: readonly VectorCount[]): number {
  let bytes = storedBytes * rate.perStoredByte
  for (const { dimension, count } of vectors) bytes += count * (rate.perVector + dimension * rate.perVectorDimension)
  return bytes
}

function footprintAt(
  rates: PathRates,
  replacesIndex: boolean,
  storedBytes: number,
  vectors: readonly VectorCount[],
): RestoreFootprint {
  const chosen = replacesIndex ? rates.worst : rates.floor
  const scale = replacesIndex ? RESTORE_ESTIMATE_MARGIN : 1 / RESTORE_ESTIMATE_MARGIN
  return {
    heapBytes: bytesAt(chosen.heap, storedBytes, vectors) * scale,
    externalBytes: bytesAt(chosen.external, storedBytes, vectors) * scale,
  }
}

function deadCountOf(dead: Uint8Array | null): number {
  if (dead === null) return 0
  let count = 0
  for (const byte of dead) {
    for (let bits = byte; bits !== 0; bits &= bits - 1) count += 1
  }
  return count
}

export function archiveFootprint(
  prepared: PreparedIndex,
  manifest: SegmentManifest,
  replacesIndex: boolean,
): RestoreFootprint {
  let segmentBytes = 0
  for (const partition of manifest.partitions) {
    for (const segment of partition.segments) segmentBytes += segment.bytes
  }
  const dimensions = extractVectorFieldsFromSchema(prepared.config.schema)
  const vectors: VectorCount[] = []
  for (const field of manifest.vectors) {
    const dimension = dimensions.get(field.fieldPath) ?? 0
    for (const file of field.files) vectors.push({ dimension, count: Math.max(0, file.count - deadCountOf(file.dead)) })
  }
  return footprintAt(ARCHIVE_RATES, replacesIndex, segmentBytes, vectors)
}

export function earlierSnapshotFootprint(
  prepared: PreparedIndex,
  partitionBytes: number,
  vectorCounts: ReadonlyMap<string, number>,
  replacesIndex: boolean,
): RestoreFootprint {
  const dimensions = extractVectorFieldsFromSchema(prepared.config.schema)
  const vectors = [...vectorCounts].map(([fieldPath, count]) => ({ dimension: dimensions.get(fieldPath) ?? 0, count }))
  return footprintAt(EARLIER_SNAPSHOT_RATES, replacesIndex, partitionBytes, vectors)
}

function inMegabytes(bytes: number): number {
  return Math.ceil(bytes / MEGABYTE_BYTES)
}

interface Shortfall {
  budget: MemoryBudget
  neededBytes: number
  availableBytes: number
}

function shortfallOf(heapBytes: number, processBytes: number, countInUse: boolean): Shortfall | null {
  const heap = readHeapStatistics()
  if (heap !== null) {
    const limitBytes = heap.configuredLimitBytes ?? heap.limitBytes
    const availableBytes = countInUse ? limitBytes - heap.usedBytes : limitBytes
    if (heapBytes > availableBytes) return { budget: 'heap', neededBytes: heapBytes, availableBytes }
  }
  const resident = readResidentMemory()
  if (resident !== null) {
    const availableBytes = countInUse ? resident.limitBytes - resident.residentBytes : resident.limitBytes
    if (processBytes > availableBytes) return { budget: 'process', neededBytes: processBytes, availableBytes }
  }
  return null
}

function refuse(indexName: string, replacesIndex: boolean, shortfall: Shortfall): never {
  const { budget, neededBytes, availableBytes } = shortfall
  const where = budget === 'heap' ? 'of JavaScript heap' : 'of process memory'
  const outcome = replacesIndex
    ? 'so the index keeps its earlier contents. Drop the index first to free the memory that it holds, or give the process more memory, then restore again'
    : 'so the engine creates no index. Give the process more memory, then restore again'
  throw new NarsilError(
    ErrorCodes.RESTORE_MEMORY_EXCEEDED,
    `The restore of index "${indexName}" needs about ${inMegabytes(neededBytes)} MB ${where}, and this process has ${inMegabytes(Math.max(0, availableBytes))} MB free, ${outcome}`,
    { indexName, budget, neededBytes, availableBytes },
  )
}

export function requireRestoreMemory(indexName: string, footprint: RestoreFootprint, replacesIndex: boolean): void {
  const processBytes = footprint.heapBytes + footprint.externalBytes
  if (shortfallOf(footprint.heapBytes, processBytes, true) === null) return
  const collected = collectAndReturnPages()
  const shortfall = shortfallOf(footprint.heapBytes, processBytes, collected || replacesIndex)
  if (shortfall !== null) refuse(indexName, replacesIndex, shortfall)
}
