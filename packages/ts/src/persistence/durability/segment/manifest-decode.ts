import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { requireValidFieldTypes } from '../../../schema/validator/schema'
import { openChecksummedEnvelope } from '../../../serialization/envelope-file'
import type { PartitionCheckpoint } from '../partition-checkpoint'
import { segmentKey } from './layout'
import {
  EARLIER_SEGMENT_MANIFEST_VERSION,
  MANIFEST_ENVELOPE_VERSION,
  MAX_SEGMENTS_PER_PARTITION,
  type PartitionManifestEntry,
  SEGMENT_MANIFEST_VERSION,
  type SegmentManifest,
  type SegmentRef,
} from './manifest'
import { invalidManifest, isId, isRecord, isSequenceNumber, isUint32, readFileRef } from './manifest-fields'
import { normalizeVectorFields } from './manifest-vectors-decode'

export type DecodedManifest =
  | { kind: 'current'; manifest: SegmentManifest }
  | { kind: 'earlier'; payload: Record<string, unknown> }

export async function openManifestPayload(data: Uint8Array): Promise<Record<string, unknown>> {
  const { payload } = await openChecksummedEnvelope(data, {
    envelopeFormatVersion: MANIFEST_ENVELOPE_VERSION,
    what: 'segment manifest',
    allowsCompression: true,
  })
  const raw = decode(payload)
  if (!isRecord(raw)) invalidManifest('is not a map')
  return raw
}

export function listedKeysOf(raw: Record<string, unknown>): string[] {
  const keys: string[] = []
  for (const partition of Array.isArray(raw.partitions) ? raw.partitions : []) {
    if (!isRecord(partition) || !Array.isArray(partition.segments)) continue
    for (const segment of partition.segments)
      if (isRecord(segment) && typeof segment.key === 'string') keys.push(segment.key)
  }
  for (const field of Array.isArray(raw.vectors) ? raw.vectors : []) {
    if (!isRecord(field)) continue
    for (const list of [field.files, field.graphParts]) {
      if (!Array.isArray(list)) continue
      for (const file of list) if (isRecord(file) && typeof file.key === 'string') keys.push(file.key)
    }
  }
  return keys
}

export async function decodeSegmentManifest(data: Uint8Array, indexName: string): Promise<DecodedManifest> {
  return decodeManifestPayload(await openManifestPayload(data), indexName)
}

export function decodeManifestPayload(raw: Record<string, unknown>, indexName: string): DecodedManifest {
  if (raw.version === EARLIER_SEGMENT_MANIFEST_VERSION) return { kind: 'earlier', payload: raw }
  if (raw.version !== SEGMENT_MANIFEST_VERSION) {
    throw new NarsilError(
      ErrorCodes.ENVELOPE_VERSION_MISMATCH,
      `The segment manifest of index "${indexName}" holds layout ${String(raw.version)}, which this release cannot open. Export the index with the release that wrote it and import the export`,
      { indexName, version: raw.version },
    )
  }
  const schema = raw.schema
  if (!isRecord(schema)) invalidManifest('is missing its schema')
  requireValidFieldTypes(schema)
  if (typeof raw.language !== 'string') invalidManifest('is missing its language')
  return {
    kind: 'current',
    manifest: {
      version: SEGMENT_MANIFEST_VERSION,
      schema: schema as Record<string, string>,
      language: raw.language,
      checkpoint: normalizeCheckpoint(raw.checkpoint),
      partitions: normalizePartitions(raw.partitions, indexName),
      vectors: normalizeVectorFields(raw.vectors, indexName),
    },
  }
}

export function normalizeCheckpoint(raw: unknown): PartitionCheckpoint[] {
  if (!Array.isArray(raw)) invalidManifest('is missing its checkpoint list')
  const seen = new Set<number>()
  return raw.map(entry => {
    if (
      !isRecord(entry) ||
      !isUint32(entry.partitionId) ||
      !isSequenceNumber(entry.lastSeqNo) ||
      !isSequenceNumber(entry.primaryTerm) ||
      seen.has(entry.partitionId)
    ) {
      invalidManifest('has an invalid partition checkpoint', { entry })
    }
    seen.add(entry.partitionId)
    return { partitionId: entry.partitionId, lastSeqNo: entry.lastSeqNo, primaryTerm: entry.primaryTerm }
  })
}

function normalizePartitions(raw: unknown, indexName: string): PartitionManifestEntry[] {
  if (!Array.isArray(raw)) invalidManifest('is missing partition entries')
  const seen = new Set<number>()
  return raw.map(entry => {
    if (!isRecord(entry) || !isUint32(entry.partitionId) || seen.has(entry.partitionId)) {
      invalidManifest('has a partition without a valid id', { partitionId: isRecord(entry) ? entry.partitionId : null })
    }
    seen.add(entry.partitionId)
    const segments = normalizeSegments(entry.segments, indexName, entry.partitionId)
    return {
      partitionId: entry.partitionId,
      nextSegmentId: readNextSegmentId(entry.nextSegmentId, segments, entry.partitionId),
      segments,
    }
  })
}

function normalizeSegments(raw: unknown, indexName: string, partitionId: number): SegmentRef[] {
  if (!Array.isArray(raw)) invalidManifest('has malformed segment references', { partitionId })
  if (raw.length > MAX_SEGMENTS_PER_PARTITION) {
    invalidManifest(`lists ${raw.length} segments for partition ${partitionId}, above ${MAX_SEGMENTS_PER_PARTITION}`)
  }
  const seenIds = new Set<number>()
  return raw.map(segment => {
    if (!isRecord(segment) || !isId(segment.id) || !isUint32(segment.docCount) || !isUint32(segment.tombstoneCount)) {
      invalidManifest('has an invalid segment reference', { partitionId })
    }
    if (seenIds.has(segment.id)) invalidManifest(`reuses segment id ${segment.id} in partition ${partitionId}`)
    seenIds.add(segment.id)
    const ref = readFileRef(segment, segmentKey(indexName, partitionId, segment.id), 'segment')
    return { ...ref, id: segment.id, docCount: segment.docCount, tombstoneCount: segment.tombstoneCount }
  })
}

function readNextSegmentId(value: unknown, segments: readonly SegmentRef[], partitionId: number): number {
  if (!isId(value)) invalidManifest('has an invalid next segment id', { partitionId })
  for (const segment of segments) {
    if (segment.id >= value) {
      invalidManifest(`next segment id ${value} does not exceed segment id ${segment.id}`, { partitionId })
    }
  }
  return value
}
