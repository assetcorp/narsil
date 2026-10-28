import { readHeapStatistics } from '#platform/heap-statistics'
import { readResidentMemory } from '#platform/process-limit'
import { ErrorCodes, NarsilError } from '../../errors'
import type { SegmentManifest } from '../../persistence/durability/segment/manifest'
import { extractVectorFieldsFromSchema } from '../../schema/validator'
import { osqBitsOf } from '../../vector/osq/quantize'
import { osqRecordBytes } from '../../vector/osq/record'
import { defaultQuantizationFor } from '../../vector/vector-index'
import { alignUp } from '../../vector/vector-store/blocks'
import {
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
  storedBytes: number
  heapBytes: number
  vectorBytes: number
}

type MemoryBudget = 'heap' | 'process'

function bytesPerVector(prepared: PreparedIndex, dimension: number, filesystemDurability: boolean): number {
  const promotion = prepared.config.vectorPromotion
  const bits = osqBitsOf(promotion?.quantization ?? defaultQuantizationFor(dimension))
  const codeBytes = bits === null ? 0 : osqRecordBytes(dimension, bits)
  const storage = promotion?.storage ?? (filesystemDurability ? 'disk' : 'memory')
  return storage === 'memory' ? alignUp(dimension * 4) + codeBytes : codeBytes
}

interface VectorHeapRate {
  perVector: number
  perDimension: number
}

const ARCHIVE_VECTOR_HEAP: VectorHeapRate = {
  perVector: RESTORE_HEAP_BYTES_PER_VECTOR,
  perDimension: RESTORE_HEAP_BYTES_PER_VECTOR_DIMENSION,
}

const EARLIER_SNAPSHOT_VECTOR_HEAP: VectorHeapRate = {
  perVector: RESTORE_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR,
  perDimension: RESTORE_HEAP_BYTES_PER_EARLIER_SNAPSHOT_VECTOR_DIMENSION,
}

function heapPerVector(rate: VectorHeapRate, dimension: number): number {
  return rate.perVector + dimension * rate.perDimension
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
  filesystemDurability: boolean,
): RestoreFootprint {
  let segmentBytes = 0
  for (const partition of manifest.partitions) {
    for (const segment of partition.segments) segmentBytes += segment.bytes
  }
  const dimensions = extractVectorFieldsFromSchema(prepared.config.schema)
  let vectorBytes = 0
  let heapBytes = segmentBytes * RESTORE_HEAP_BYTES_PER_STORED_BYTE
  for (const field of manifest.vectors) {
    const dimension = dimensions.get(field.fieldPath) ?? 0
    const perVector = bytesPerVector(prepared, dimension, filesystemDurability)
    const heapBytesPerVector = heapPerVector(ARCHIVE_VECTOR_HEAP, dimension)
    for (const file of field.files) {
      const live = Math.max(0, file.count - deadCountOf(file.dead))
      vectorBytes += live * perVector
      heapBytes += live * heapBytesPerVector
    }
    for (const part of field.graphParts) vectorBytes += part.bytes
  }
  return { storedBytes: segmentBytes, heapBytes, vectorBytes }
}

export function earlierSnapshotFootprint(
  prepared: PreparedIndex,
  partitionBytes: number,
  vectorCounts: ReadonlyMap<string, number>,
  filesystemDurability: boolean,
): RestoreFootprint {
  const dimensions = extractVectorFieldsFromSchema(prepared.config.schema)
  let vectorBytes = 0
  let heapBytes = partitionBytes * RESTORE_HEAP_BYTES_PER_EARLIER_SNAPSHOT_BYTE
  for (const [fieldPath, count] of vectorCounts) {
    const dimension = dimensions.get(fieldPath) ?? 0
    vectorBytes += count * bytesPerVector(prepared, dimension, filesystemDurability)
    heapBytes += count * heapPerVector(EARLIER_SNAPSHOT_VECTOR_HEAP, dimension)
  }
  return { storedBytes: partitionBytes, heapBytes, vectorBytes }
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
    const neededBytes = footprint.storedBytes + footprint.heapBytes + footprint.vectorBytes
    const availableBytes = resident.limitBytes - resident.residentBytes
    if (neededBytes > availableBytes) refuse(indexName, 'process', neededBytes, availableBytes)
  }
}
