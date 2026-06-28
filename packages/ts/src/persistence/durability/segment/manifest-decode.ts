import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { unpackEnvelopeBytes } from '../../../serialization/envelope'
import type { PartitionCheckpoint } from '../snapshot-bundle'
import { MAX_GLOBAL_DEPTH } from './layout'
import {
  type BucketSegmentRef,
  LEGACY_FIXED_COUNT_MANIFEST_VERSION,
  MAX_BUCKET_COUNT,
  type PartitionManifestEntry,
  SEGMENT_MANIFEST_VERSION,
  type SegmentManifest,
  type VectorSegmentRef,
} from './manifest'

interface RawBucketRef {
  bucketId?: number
  localDepth?: number
  generation?: number
  key?: string
}

interface RawVectorRef {
  fieldPath?: string
  generation?: number
  key?: string
}

interface RawPartitionEntry {
  partitionId?: number
  globalDepth?: number
  directory?: number[]
  buckets?: RawBucketRef[]
  vectors?: RawVectorRef[]
}

interface RawManifest {
  version?: number
  bucketCount?: number
  initialBucketCount?: number
  schema?: Record<string, string>
  language?: string
  checkpoint?: Array<{ partitionId?: number; lastSeqNo?: number; primaryTerm?: number }>
  partitions?: RawPartitionEntry[]
}

export async function decodeSegmentManifest(data: Uint8Array): Promise<SegmentManifest> {
  const { payloadBytes } = await unpackEnvelopeBytes(data)
  const raw = decode(payloadBytes) as RawManifest

  if (raw.version === LEGACY_FIXED_COUNT_MANIFEST_VERSION) {
    return migrateFixedCountManifest(raw)
  }
  if (raw.version !== SEGMENT_MANIFEST_VERSION) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Unsupported segment manifest version ${raw.version}; expected ${SEGMENT_MANIFEST_VERSION}`,
      { version: raw.version },
    )
  }

  const initialBucketCount = readInitialBucketCount(raw.initialBucketCount)
  const base = validateManifestCommon(raw)

  return {
    version: SEGMENT_MANIFEST_VERSION,
    initialBucketCount,
    schema: base.schema,
    language: base.language,
    checkpoint: normalizeCheckpoint(raw.checkpoint),
    partitions: normalizePartitions(raw.partitions),
  }
}

function migrateFixedCountManifest(raw: RawManifest): SegmentManifest {
  if (!isPositiveInteger(raw.bucketCount)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has an invalid bucket count', {
      bucketCount: raw.bucketCount,
    })
  }
  if (!isPowerOfTwo(raw.bucketCount)) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Segment manifest bucket count ${raw.bucketCount} from the fixed-count format is not a power of two and cannot be migrated to directory routing`,
      { bucketCount: raw.bucketCount },
    )
  }
  if (raw.bucketCount > MAX_BUCKET_COUNT) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Segment manifest bucket count ${raw.bucketCount} exceeds the maximum of ${MAX_BUCKET_COUNT}`,
      { bucketCount: raw.bucketCount, maximum: MAX_BUCKET_COUNT },
    )
  }

  const base = validateManifestCommon(raw)
  const globalDepth = log2OfPowerOfTwo(raw.bucketCount)
  const partitions = normalizeLegacyPartitions(raw.partitions, globalDepth)

  return {
    version: SEGMENT_MANIFEST_VERSION,
    initialBucketCount: raw.bucketCount,
    schema: base.schema,
    language: base.language,
    checkpoint: normalizeCheckpoint(raw.checkpoint),
    partitions,
  }
}

function readInitialBucketCount(value: unknown): number {
  if (!isPositiveInteger(value)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has an invalid initial bucket count', {
      initialBucketCount: value,
    })
  }
  if (value > MAX_BUCKET_COUNT) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Segment manifest initial bucket count ${value} exceeds the maximum of ${MAX_BUCKET_COUNT}`,
      { initialBucketCount: value, maximum: MAX_BUCKET_COUNT },
    )
  }
  return value
}

function validateManifestCommon(raw: RawManifest): { schema: Record<string, string>; language: string } {
  if (raw.schema === undefined || typeof raw.schema !== 'object') {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest is missing schema')
  }
  if (typeof raw.language !== 'string') {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest is missing language')
  }
  return { schema: raw.schema, language: raw.language }
}

function normalizeCheckpoint(raw: RawManifest['checkpoint']): PartitionCheckpoint[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const result: PartitionCheckpoint[] = []
  for (const entry of raw) {
    if (
      typeof entry?.partitionId !== 'number' ||
      typeof entry.lastSeqNo !== 'number' ||
      typeof entry.primaryTerm !== 'number'
    ) {
      continue
    }
    result.push({ partitionId: entry.partitionId, lastSeqNo: entry.lastSeqNo, primaryTerm: entry.primaryTerm })
  }
  return result
}

function normalizePartitions(raw: RawManifest['partitions']): PartitionManifestEntry[] {
  if (!Array.isArray(raw)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest is missing partition entries')
  }
  const result: PartitionManifestEntry[] = []
  for (const entry of raw) {
    if (!isNonNegativeInteger(entry?.partitionId)) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has a partition without a valid id', {
        partitionId: entry?.partitionId,
      })
    }
    const globalDepth = readGlobalDepth(entry.globalDepth, entry.partitionId)
    const buckets = normalizeBuckets(entry.buckets, entry.partitionId, globalDepth)
    const directory = normalizeDirectory(entry.directory, entry.partitionId, globalDepth)
    validateBucketIdStructure(directory, buckets, entry.partitionId)
    result.push({
      partitionId: entry.partitionId,
      globalDepth,
      directory,
      buckets,
      vectors: normalizeVectors(entry.vectors, entry.partitionId),
    })
  }
  return result
}

function normalizeLegacyPartitions(raw: RawManifest['partitions'], globalDepth: number): PartitionManifestEntry[] {
  if (!Array.isArray(raw)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest is missing partition entries')
  }
  const size = 1 << globalDepth
  const result: PartitionManifestEntry[] = []
  for (const entry of raw) {
    if (!isNonNegativeInteger(entry?.partitionId)) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has a partition without a valid id', {
        partitionId: entry?.partitionId,
      })
    }
    const buckets = normalizeLegacyBuckets(entry.buckets, entry.partitionId, globalDepth)
    const directory: number[] = new Array(size)
    for (let slot = 0; slot < size; slot += 1) {
      directory[slot] = slot
    }
    result.push({
      partitionId: entry.partitionId,
      globalDepth,
      directory,
      buckets,
      vectors: normalizeVectors(entry.vectors, entry.partitionId),
    })
  }
  return result
}

function readGlobalDepth(value: unknown, partitionId: number): number {
  if (!isNonNegativeInteger(value) || value > MAX_GLOBAL_DEPTH) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has an invalid global depth', {
      partitionId,
      globalDepth: value,
      maxGlobalDepth: MAX_GLOBAL_DEPTH,
    })
  }
  return value
}

function normalizeBuckets(
  raw: RawBucketRef[] | undefined,
  partitionId: number,
  globalDepth: number,
): BucketSegmentRef[] {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has malformed bucket references', {
      partitionId,
    })
  }
  const result: BucketSegmentRef[] = []
  for (const bucket of raw) {
    if (
      !isNonNegativeInteger(bucket?.bucketId) ||
      !isNonNegativeInteger(bucket.localDepth) ||
      bucket.localDepth > globalDepth ||
      !isNonNegativeInteger(bucket.generation) ||
      !isKey(bucket.key)
    ) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has an invalid bucket reference', {
        partitionId,
        bucket,
      })
    }
    result.push({
      bucketId: bucket.bucketId,
      localDepth: bucket.localDepth,
      generation: bucket.generation,
      key: bucket.key,
    })
  }
  return result
}

function normalizeLegacyBuckets(
  raw: RawBucketRef[] | undefined,
  partitionId: number,
  globalDepth: number,
): BucketSegmentRef[] {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has malformed bucket references', {
      partitionId,
    })
  }
  const result: BucketSegmentRef[] = []
  for (const bucket of raw) {
    if (!isNonNegativeInteger(bucket?.bucketId) || !isNonNegativeInteger(bucket.generation) || !isKey(bucket.key)) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has an invalid bucket reference', {
        partitionId,
        bucket,
      })
    }
    result.push({ bucketId: bucket.bucketId, localDepth: globalDepth, generation: bucket.generation, key: bucket.key })
  }
  return result
}

function normalizeDirectory(raw: number[] | undefined, partitionId: number, globalDepth: number): number[] {
  const expectedSize = 1 << globalDepth
  if (!Array.isArray(raw) || raw.length !== expectedSize) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Segment manifest directory size ${Array.isArray(raw) ? raw.length : 'missing'} does not match 2^${globalDepth}`,
      { partitionId, globalDepth, expectedSize },
    )
  }
  const directory: number[] = new Array(expectedSize)
  for (let slot = 0; slot < expectedSize; slot += 1) {
    const bucketId = raw[slot]
    if (!isNonNegativeInteger(bucketId)) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest directory has an invalid slot', {
        partitionId,
        slot,
        bucketId,
      })
    }
    directory[slot] = bucketId
  }
  return directory
}

function validateBucketIdStructure(directory: number[], buckets: BucketSegmentRef[], partitionId: number): void {
  const distinctIds = new Set(directory)
  let highest = -1
  for (const bucketId of distinctIds) {
    if (bucketId > highest) {
      highest = bucketId
    }
  }
  if (highest !== distinctIds.size - 1) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      'Segment manifest directory bucket ids are not a dense range starting at zero',
      { partitionId, distinctCount: distinctIds.size, highestBucketId: highest },
    )
  }
  for (const bucket of buckets) {
    if (!distinctIds.has(bucket.bucketId)) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        'Segment manifest has a bucket segment that no directory slot references',
        { partitionId, bucketId: bucket.bucketId },
      )
    }
  }
}

function normalizeVectors(raw: RawVectorRef[] | undefined, partitionId: number): VectorSegmentRef[] {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has malformed vector references', {
      partitionId,
    })
  }
  const result: VectorSegmentRef[] = []
  for (const vector of raw) {
    if (typeof vector?.fieldPath !== 'string' || !isNonNegativeInteger(vector.generation) || !isKey(vector.key)) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has an invalid vector reference', {
        partitionId,
        vector,
      })
    }
    result.push({ fieldPath: vector.fieldPath, generation: vector.generation, key: vector.key })
  }
  return result
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0
}

function log2OfPowerOfTwo(value: number): number {
  let depth = 0
  let remaining = value
  while (remaining > 1) {
    remaining >>= 1
    depth += 1
  }
  return depth
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}
