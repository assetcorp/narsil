import type { SegmentManifest } from './segment/manifest'

export interface PartitionStoredBytes {
  partitionId: number
  bytes: number
}

export interface StoredBytes {
  bytes: number
  vectorBytes: number
  partitions: PartitionStoredBytes[]
}

export const NOTHING_SAVED: StoredBytes = { bytes: 0, vectorBytes: 0, partitions: [] }

export function savedBytesOfManifest(manifest: SegmentManifest): StoredBytes {
  let bytes = 0
  const partitions: PartitionStoredBytes[] = []
  for (const partition of manifest.partitions) {
    let partitionBytes = 0
    for (const segment of partition.segments) partitionBytes += segment.bytes
    partitions.push({ partitionId: partition.partitionId, bytes: partitionBytes })
    bytes += partitionBytes
  }
  let vectorBytes = 0
  for (const field of manifest.vectors) {
    for (const file of field.files) vectorBytes += file.bytes
    for (const part of field.graphParts) vectorBytes += part.bytes
  }
  return { bytes: bytes + vectorBytes, vectorBytes, partitions }
}
