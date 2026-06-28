import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { unpackEnvelopeBytes } from '../../../serialization/envelope'
import type { PartitionCheckpoint } from '../snapshot-bundle'
import {
  MAX_SEGMENT_ID,
  MAX_SEGMENTS_PER_PARTITION,
  type PartitionManifestEntry,
  SEGMENT_MANIFEST_VERSION,
  type SegmentManifest,
  type SegmentRef,
  type VectorSegmentRef,
} from './manifest'

interface RawSegmentRef {
  id?: number
  key?: string
  docCount?: number
  tombstoneCount?: number
}

interface RawVectorRef {
  fieldPath?: string
  generation?: number
  key?: string
}

interface RawPartitionEntry {
  partitionId?: number
  nextSegmentId?: number
  segments?: RawSegmentRef[]
  vectors?: RawVectorRef[]
}

interface RawManifest {
  version?: number
  schema?: Record<string, string>
  language?: string
  checkpoint?: Array<{ partitionId?: number; lastSeqNo?: number; primaryTerm?: number }>
  partitions?: RawPartitionEntry[]
}

export async function decodeSegmentManifest(data: Uint8Array): Promise<SegmentManifest> {
  const { payloadBytes } = await unpackEnvelopeBytes(data)
  const raw = decode(payloadBytes) as RawManifest

  if (raw.version !== SEGMENT_MANIFEST_VERSION) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Unsupported segment manifest version ${raw.version}; expected ${SEGMENT_MANIFEST_VERSION}`,
      { version: raw.version },
    )
  }

  const base = validateManifestCommon(raw)

  return {
    version: SEGMENT_MANIFEST_VERSION,
    schema: base.schema,
    language: base.language,
    checkpoint: normalizeCheckpoint(raw.checkpoint),
    partitions: normalizePartitions(raw.partitions),
  }
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
    const segments = normalizeSegments(entry.segments, entry.partitionId)
    const nextSegmentId = readNextSegmentId(entry.nextSegmentId, segments, entry.partitionId)
    result.push({
      partitionId: entry.partitionId,
      nextSegmentId,
      segments,
      vectors: normalizeVectors(entry.vectors, entry.partitionId),
    })
  }
  return result
}

function normalizeSegments(raw: RawSegmentRef[] | undefined, partitionId: number): SegmentRef[] {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has malformed segment references', {
      partitionId,
    })
  }
  if (raw.length > MAX_SEGMENTS_PER_PARTITION) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Segment manifest lists ${raw.length} segments for partition ${partitionId}, exceeding the maximum of ${MAX_SEGMENTS_PER_PARTITION}`,
      { partitionId, segmentCount: raw.length, maximum: MAX_SEGMENTS_PER_PARTITION },
    )
  }
  const seenIds = new Set<number>()
  const result: SegmentRef[] = []
  for (const segment of raw) {
    if (
      !isSegmentId(segment?.id) ||
      !isNonNegativeInteger(segment.docCount) ||
      !isNonNegativeInteger(segment.tombstoneCount) ||
      !isKey(segment.key)
    ) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has an invalid segment reference', {
        partitionId,
        segment,
      })
    }
    if (seenIds.has(segment.id)) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Segment manifest reuses segment id ${segment.id} in partition ${partitionId}`,
        { partitionId, segmentId: segment.id },
      )
    }
    seenIds.add(segment.id)
    result.push({
      id: segment.id,
      key: segment.key,
      docCount: segment.docCount,
      tombstoneCount: segment.tombstoneCount,
    })
  }
  return result
}

function readNextSegmentId(value: unknown, segments: SegmentRef[], partitionId: number): number {
  if (!isSegmentId(value)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment manifest has an invalid next segment id', {
      partitionId,
      nextSegmentId: value,
    })
  }
  for (const segment of segments) {
    if (segment.id >= value) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Segment manifest next segment id ${value} does not exceed an existing segment id ${segment.id}`,
        { partitionId, nextSegmentId: value, segmentId: segment.id },
      )
    }
  }
  return value
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isSegmentId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SEGMENT_ID
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}
