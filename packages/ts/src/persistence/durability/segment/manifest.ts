import { encode } from '@msgpack/msgpack'
import { type EnvelopeParts, packSnapshotEnvelopePartsRetrying } from '../../../serialization/envelope'
import type { PartitionCheckpoint } from '../snapshot-bundle'

export const SEGMENT_MANIFEST_VERSION = 3

export const MAX_SEGMENTS_PER_PARTITION = 65_536

export const MAX_SEGMENT_ID = 0xffff_ffff_ffff

export interface SegmentRef {
  id: number
  key: string
  docCount: number
  tombstoneCount: number
}

export interface VectorSegmentRef {
  fieldPath: string
  generation: number
  key: string
}

export interface PartitionManifestEntry {
  partitionId: number
  nextSegmentId: number
  segments: SegmentRef[]
  vectors: VectorSegmentRef[]
}

export interface SegmentManifest {
  version: typeof SEGMENT_MANIFEST_VERSION
  schema: Record<string, string>
  language: string
  checkpoint: PartitionCheckpoint[]
  partitions: PartitionManifestEntry[]
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
        vectors: p.vectors.map(v => ({ fieldPath: v.fieldPath, generation: v.generation, key: v.key })),
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
    for (const vector of partition.vectors) {
      keys.add(vector.key)
    }
  }
  return keys
}

export { decodeSegmentManifest } from './manifest-decode'
