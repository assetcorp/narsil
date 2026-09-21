import { encode } from '@msgpack/msgpack'
import { type EnvelopeParts, packSnapshotEnvelopePartsRetrying } from '../../../serialization/envelope'
import type { PartitionCheckpoint } from '../snapshot-bundle'

export const SEGMENT_MANIFEST_VERSION = 6

export const MAX_SEGMENTS_PER_PARTITION = 65_536

export const MAX_SEGMENT_ID = 0xffff_ffff_ffff

export interface SegmentRef {
  id: number
  key: string
  docCount: number
  tombstoneCount: number
}

export interface VectorFileRef {
  id: number
  key: string
  /** The file holds this many vectors, dead ones included. */
  count: number
  /** Bit `i` reads 1 where vector `i` of the file is dead, and null while every vector is live. */
  dead: Uint8Array | null
}

export interface VectorFieldRef {
  fieldPath: string
  nextFileId: number
  /** The field's vector files, whose order numbers every vector of the field. */
  files: VectorFileRef[]
  graphGeneration: number
  /** The field's graph file lies under this key, and null while the field holds no graph. */
  graphKey: string | null
}

export interface PartitionManifestEntry {
  partitionId: number
  nextSegmentId: number
  segments: SegmentRef[]
}

export interface SegmentManifest {
  version: typeof SEGMENT_MANIFEST_VERSION
  schema: Record<string, string>
  language: string
  checkpoint: PartitionCheckpoint[]
  partitions: PartitionManifestEntry[]
  vectors: VectorFieldRef[]
}

export function encodeSegmentManifest(manifest: SegmentManifest): Promise<EnvelopeParts> {
  return packSnapshotEnvelopePartsRetrying(() =>
    encode({
      version: SEGMENT_MANIFEST_VERSION,
      schema: manifest.schema,
      language: manifest.language,
      checkpoint: manifest.checkpoint.map(c => ({
        partitionId: c.partitionId,
        lastSeqNo: c.lastSeqNo,
        primaryTerm: c.primaryTerm,
      })),
      partitions: manifest.partitions.map(p => ({
        partitionId: p.partitionId,
        nextSegmentId: p.nextSegmentId,
        segments: p.segments.map(s => ({
          id: s.id,
          key: s.key,
          docCount: s.docCount,
          tombstoneCount: s.tombstoneCount,
        })),
      })),
      vectors: manifest.vectors.map(v => ({
        fieldPath: v.fieldPath,
        nextFileId: v.nextFileId,
        files: v.files.map(f => ({ id: f.id, key: f.key, count: f.count, dead: f.dead })),
        graphGeneration: v.graphGeneration,
        graphKey: v.graphKey,
      })),
    }),
  )
}

export function manifestReferencedKeys(manifest: SegmentManifest): Set<string> {
  const keys = new Set<string>()
  for (const partition of manifest.partitions) {
    for (const segment of partition.segments) {
      keys.add(segment.key)
    }
  }
  for (const vector of manifest.vectors) {
    for (const file of vector.files) keys.add(file.key)
    if (vector.graphKey !== null) keys.add(vector.graphKey)
  }
  return keys
}

export { decodeSegmentManifest } from './manifest-decode'
