import { requireValidFieldTypes } from '../../../schema/validator/schema'
import { VECTOR_FILE_MAX_VECTORS } from '../../../vector/vector-index/checkpoint-payload'
import { deadBytesFor } from '../../../vector/vector-index/dead-bits'
import type { PartitionCheckpoint } from '../partition-checkpoint'
import { MAX_SEGMENTS_PER_PARTITION } from '../segment/manifest'
import { invalidManifest, isId, isRecord, isSequenceNumber, isUint32 } from '../segment/manifest-fields'

export interface EarlierSegmentRef {
  id: number
  key: string
  docCount: number
  tombstoneCount: number
}

export interface EarlierPartitionEntry {
  partitionId: number
  nextSegmentId: number
  segments: EarlierSegmentRef[]
}

export interface EarlierVectorFileRef {
  id: number
  key: string
  count: number
  dead: Uint8Array | null
}

export interface EarlierVectorFieldRef {
  fieldPath: string
  nextFileId: number
  files: EarlierVectorFileRef[]
  graphGeneration: number
  graphKey: string | null
}

export interface EarlierManifest {
  schema: Record<string, string>
  language: string
  checkpoint: PartitionCheckpoint[]
  partitions: EarlierPartitionEntry[]
  vectors: EarlierVectorFieldRef[]
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

function checkpointOf(raw: unknown): PartitionCheckpoint[] {
  if (!Array.isArray(raw)) return []
  const result: PartitionCheckpoint[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || !isUint32(entry.partitionId)) continue
    if (!isSequenceNumber(entry.lastSeqNo) || !isSequenceNumber(entry.primaryTerm)) continue
    result.push({ partitionId: entry.partitionId, lastSeqNo: entry.lastSeqNo, primaryTerm: entry.primaryTerm })
  }
  return result
}

function segmentsOf(raw: unknown, partitionId: number): EarlierSegmentRef[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_SEGMENTS_PER_PARTITION) {
    invalidManifest('has malformed segment references', { partitionId })
  }
  const seen = new Set<number>()
  return raw.map(segment => {
    if (
      !isRecord(segment) ||
      !isId(segment.id) ||
      !isUint32(segment.docCount) ||
      !isUint32(segment.tombstoneCount) ||
      !isKey(segment.key) ||
      seen.has(segment.id)
    ) {
      invalidManifest('has an invalid segment reference', { partitionId })
    }
    seen.add(segment.id)
    return { id: segment.id, key: segment.key, docCount: segment.docCount, tombstoneCount: segment.tombstoneCount }
  })
}

function partitionsOf(raw: unknown): EarlierPartitionEntry[] {
  if (!Array.isArray(raw)) invalidManifest('is missing partition entries')
  return raw.map(entry => {
    if (!isRecord(entry) || !isUint32(entry.partitionId)) invalidManifest('has a partition without a valid id')
    const segments = segmentsOf(entry.segments, entry.partitionId)
    const nextSegmentId = entry.nextSegmentId
    if (!isId(nextSegmentId) || segments.some(segment => segment.id >= nextSegmentId)) {
      invalidManifest('has an invalid next segment id', { partitionId: entry.partitionId })
    }
    return { partitionId: entry.partitionId, nextSegmentId, segments }
  })
}

function vectorFileOf(raw: unknown, fieldPath: string): EarlierVectorFileRef {
  if (!isRecord(raw) || !isId(raw.id) || !isKey(raw.key)) invalidManifest('has an invalid vector file reference')
  const count = raw.count
  if (!isUint32(count) || count > VECTOR_FILE_MAX_VECTORS) invalidManifest(`gives "${fieldPath}" an invalid count`)
  const dead = raw.dead ?? null
  if (dead !== null && (!(dead instanceof Uint8Array) || dead.byteLength !== deadBytesFor(count))) {
    invalidManifest(`marks the dead vectors of "${fieldPath}" with the wrong number of bytes`)
  }
  return { id: raw.id, key: raw.key, count, dead }
}

function vectorsOf(raw: unknown): EarlierVectorFieldRef[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) invalidManifest('has malformed vector references')
  return raw.map(field => {
    if (!isRecord(field) || typeof field.fieldPath !== 'string') invalidManifest('has an invalid vector reference')
    const fieldPath = field.fieldPath
    if (!isId(field.nextFileId) || !Array.isArray(field.files) || !isId(field.graphGeneration)) {
      invalidManifest(`gives "${fieldPath}" an invalid vector reference`)
    }
    const graphKey = field.graphKey ?? null
    if (graphKey !== null && (!isKey(graphKey) || field.graphGeneration === 0)) {
      invalidManifest(`gives "${fieldPath}" an invalid graph key`)
    }
    return {
      fieldPath,
      nextFileId: field.nextFileId,
      files: field.files.map(file => vectorFileOf(file, fieldPath)),
      graphGeneration: field.graphGeneration,
      graphKey,
    }
  })
}

export function decodeEarlierManifest(raw: Record<string, unknown>): EarlierManifest {
  const schema = raw.schema
  if (!isRecord(schema)) invalidManifest('is missing its schema')
  requireValidFieldTypes(schema)
  if (typeof raw.language !== 'string') invalidManifest('is missing its language')
  return {
    schema: schema as Record<string, string>,
    language: raw.language,
    checkpoint: checkpointOf(raw.checkpoint),
    partitions: partitionsOf(raw.partitions),
    vectors: vectorsOf(raw.vectors),
  }
}

export function earlierReferencedKeys(manifest: EarlierManifest): Set<string> {
  const keys = new Set<string>()
  for (const partition of manifest.partitions) {
    for (const segment of partition.segments) keys.add(segment.key)
  }
  for (const vector of manifest.vectors) {
    for (const file of vector.files) keys.add(file.key)
    if (vector.graphKey !== null) keys.add(vector.graphKey)
  }
  return keys
}
