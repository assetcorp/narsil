import { readHeapStatistics } from '#platform/heap-statistics'
import { readResidentMemory } from '#platform/process-limit'
import { ErrorCodes, NarsilError } from '../../errors'
import type { SegmentManifest } from '../../persistence/durability/segment/manifest'
import { extractVectorFieldsFromSchema } from '../../schema/validator'
import {
  RESTORE_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_BYTE,
  RESTORE_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_VECTOR,
  RESTORE_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_VECTOR_DIMENSION,
  RESTORE_EXTERNAL_BYTES_PER_STORED_BYTE,
  RESTORE_EXTERNAL_BYTES_PER_VECTOR,
  RESTORE_EXTERNAL_BYTES_PER_VECTOR_DIMENSION,
  RESTORE_HEAP_BYTES_PER_EARLIER_SNAPSHOT_BYTE,
  RESTORE_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR,
  RESTORE_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR_DIMENSION,
  RESTORE_HEAP_BYTES_PER_STORED_BYTE,
  RESTORE_HEAP_BYTES_PER_VECTOR,
  RESTORE_HEAP_BYTES_PER_VECTOR_DIMENSION,
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

const ARCHIVE_RATES: RestoreRates = {
  heap: {
    perStoredByte: RESTORE_HEAP_BYTES_PER_STORED_BYTE,
    perVector: RESTORE_HEAP_BYTES_PER_VECTOR,
    perVectorDimension: RESTORE_HEAP_BYTES_PER_VECTOR_DIMENSION,
  },
  external: {
    perStoredByte: RESTORE_EXTERNAL_BYTES_PER_STORED_BYTE,
    perVector: RESTORE_EXTERNAL_BYTES_PER_VECTOR,
    perVectorDimension: RESTORE_EXTERNAL_BYTES_PER_VECTOR_DIMENSION,
  },
}

const EARLIER_SNAPSHOT_RATES: RestoreRates = {
  heap: {
    perStoredByte: RESTORE_HEAP_BYTES_PER_EARLIER_SNAPSHOT_BYTE,
    perVector: RESTORE_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR,
    perVectorDimension: RESTORE_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR_DIMENSION,
  },
  external: {
    perStoredByte: RESTORE_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_BYTE,
    perVector: RESTORE_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_VECTOR,
    perVectorDimension: RESTORE_EXTERNAL_BYTES_PER_EARLIER_SNAPSHOT_VECTOR_DIMENSION,
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

function footprintAt(rates: RestoreRates, storedBytes: number, vectors: readonly VectorCount[]): RestoreFootprint {
  return {
    heapBytes: bytesAt(rates.heap, storedBytes, vectors),
    externalBytes: bytesAt(rates.external, storedBytes, vectors),
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

export function archiveFootprint(prepared: PreparedIndex, manifest: SegmentManifest): RestoreFootprint {
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
  return footprintAt(ARCHIVE_RATES, segmentBytes, vectors)
}

export function earlierSnapshotFootprint(
  prepared: PreparedIndex,
  partitionBytes: number,
  vectorCounts: ReadonlyMap<string, number>,
): RestoreFootprint {
  const dimensions = extractVectorFieldsFromSchema(prepared.config.schema)
  const vectors = [...vectorCounts].map(([fieldPath, count]) => ({ dimension: dimensions.get(fieldPath) ?? 0, count }))
  return footprintAt(EARLIER_SNAPSHOT_RATES, partitionBytes, vectors)
}

function inMegabytes(bytes: number): number {
  return Math.ceil(bytes / MEGABYTE_BYTES)
}

function refuse(indexName: string, budget: MemoryBudget, neededBytes: number, availableBytes: number): never {
  const where = budget === 'heap' ? 'of JavaScript heap' : 'of process memory'
  throw new NarsilError(
    ErrorCodes.RESTORE_MEMORY_EXCEEDED,
    `The restore of index "${indexName}" needs about ${inMegabytes(neededBytes)} MB ${where}, and this process has ${inMegabytes(Math.max(0, availableBytes))} MB free, so the index keeps its earlier contents. Drop the index first to free the memory that it holds, or give the process more memory, then restore again`,
    { indexName, budget, neededBytes, availableBytes },
  )
}

export function requireRestoreMemory(indexName: string, footprint: RestoreFootprint): void {
  const heap = readHeapStatistics()
  if (heap !== null) {
    const availableBytes = (heap.configuredLimitBytes ?? heap.limitBytes) - heap.usedBytes
    if (footprint.heapBytes > availableBytes) refuse(indexName, 'heap', footprint.heapBytes, availableBytes)
  }
  const resident = readResidentMemory()
  if (resident !== null) {
    const neededBytes = footprint.heapBytes + footprint.externalBytes
    const availableBytes = resident.limitBytes - resident.residentBytes
    if (neededBytes > availableBytes) refuse(indexName, 'process', neededBytes, availableBytes)
  }
}
