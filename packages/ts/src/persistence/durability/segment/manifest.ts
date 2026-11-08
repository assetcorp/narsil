import type { PartitionCheckpoint } from '../partition-checkpoint'

export const SEGMENT_MANIFEST_VERSION = 7
export const EARLIER_SEGMENT_MANIFEST_VERSION = 6
export const MANIFEST_ENVELOPE_VERSION = 2

export const MAX_SEGMENTS_PER_PARTITION = 65_536

export const MAX_SEGMENT_ID = 0xffff_ffff_ffff

export interface FileRef {
  key: string
  bytes: number
  checksum: number
  headOffset?: number
  headLength?: number
  headChecksum?: number
}

export interface SegmentRef extends FileRef {
  id: number
  docCount: number
  tombstoneCount: number
}

export interface VectorFileRef extends FileRef {
  id: number
  count: number
  dead: Uint8Array | null
}

export interface VectorFieldRef {
  fieldPath: string
  nextFileId: number
  files: VectorFileRef[]
  graphGeneration: number
  graphParts: FileRef[]
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
  analysisGeneration?: number
  checkpoint: PartitionCheckpoint[]
  partitions: PartitionManifestEntry[]
  vectors: VectorFieldRef[]
}

export function manifestWithinPartitionCount(manifest: SegmentManifest, partitionCount: number): SegmentManifest {
  return {
    ...manifest,
    checkpoint: manifest.checkpoint.filter(entry => entry.partitionId < partitionCount),
    partitions: manifest.partitions.filter(partition => partition.partitionId < partitionCount),
  }
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
    for (const part of vector.graphParts) keys.add(part.key)
  }
  return keys
}

export function manifestFileRefs(manifest: SegmentManifest): FileRef[] {
  const refs: FileRef[] = []
  for (const partition of manifest.partitions) refs.push(...partition.segments)
  for (const vector of manifest.vectors) refs.push(...vector.files, ...vector.graphParts)
  return refs
}
