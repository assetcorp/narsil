import { encode } from '@msgpack/msgpack'
import { type EnvelopeParts, packSnapshotEnvelopeParts } from '../../../serialization/envelope'
import type { PartitionCheckpoint } from '../snapshot-bundle'

export const SEGMENT_MANIFEST_VERSION = 2

export const LEGACY_FIXED_COUNT_MANIFEST_VERSION = 1

export const MAX_BUCKET_COUNT = 65_536

export interface BucketSegmentRef {
  bucketId: number
  localDepth: number
  generation: number
  key: string
}

export interface VectorSegmentRef {
  fieldPath: string
  generation: number
  key: string
}

export interface PartitionManifestEntry {
  partitionId: number
  globalDepth: number
  directory: number[]
  buckets: BucketSegmentRef[]
  vectors: VectorSegmentRef[]
}

export interface SegmentManifest {
  version: typeof SEGMENT_MANIFEST_VERSION
  initialBucketCount: number
  schema: Record<string, string>
  language: string
  checkpoint: PartitionCheckpoint[]
  partitions: PartitionManifestEntry[]
}

export async function encodeSegmentManifest(manifest: SegmentManifest): Promise<EnvelopeParts> {
  const payload = encode({
    version: SEGMENT_MANIFEST_VERSION,
    initialBucketCount: manifest.initialBucketCount,
    schema: manifest.schema,
    language: manifest.language,
    checkpoint: manifest.checkpoint.map(c => ({
      partitionId: c.partitionId,
      lastSeqNo: c.lastSeqNo,
      primaryTerm: c.primaryTerm,
    })),
    partitions: manifest.partitions.map(p => ({
      partitionId: p.partitionId,
      globalDepth: p.globalDepth,
      directory: p.directory,
      buckets: p.buckets.map(b => ({
        bucketId: b.bucketId,
        localDepth: b.localDepth,
        generation: b.generation,
        key: b.key,
      })),
      vectors: p.vectors.map(v => ({ fieldPath: v.fieldPath, generation: v.generation, key: v.key })),
    })),
  })
  return packSnapshotEnvelopeParts(payload)
}

export function manifestReferencedKeys(manifest: SegmentManifest): Set<string> {
  const keys = new Set<string>()
  for (const partition of manifest.partitions) {
    for (const bucket of partition.buckets) {
      keys.add(bucket.key)
    }
    for (const vector of partition.vectors) {
      keys.add(vector.key)
    }
  }
  return keys
}

export { decodeSegmentManifest } from './manifest-decode'
