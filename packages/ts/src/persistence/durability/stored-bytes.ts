import type { SegmentManifest } from './segment/manifest'

export interface PartitionStoredBytes {
  partitionId: number
  bytes: number
}

export interface StoredBytes {
  bytes: number
  partitions: PartitionStoredBytes[]
}

export const NOTHING_SAVED: StoredBytes = { bytes: 0, partitions: [] }

export function savedBytesOfManifest(manifest: SegmentManifest): StoredBytes {
  let bytes = 0
  const partitions: PartitionStoredBytes[] = []
  for (const partition of manifest.partitions) {
    let partitionBytes = 0
    for (const segment of partition.segments) partitionBytes += segment.bytes
    partitions.push({ partitionId: partition.partitionId, bytes: partitionBytes })
    bytes += partitionBytes
  }
  for (const field of manifest.vectors) {
    for (const file of field.files) bytes += file.bytes
    for (const part of field.graphParts) bytes += part.bytes
  }
  return { bytes, partitions }
}

export interface StoredSize {
  savedBytes?: number
  logBytes?: number
}

export function partitionSavedBytes(saved: StoredBytes | undefined): Map<number, number> {
  const byPartition = new Map<number, number>()
  for (const { partitionId, bytes } of saved?.partitions ?? []) byPartition.set(partitionId, bytes)
  return byPartition
}

export interface SavedBytesRecord {
  record(indexName: string, saved: StoredBytes): void
  of(indexName: string): StoredBytes | undefined
  forget(indexName: string): void
}

export function createSavedBytesRecord(): SavedBytesRecord {
  const saved = new Map<string, StoredBytes>()
  return {
    record: (indexName, bytes) => {
      saved.set(indexName, bytes)
    },
    of: indexName => saved.get(indexName),
    forget: indexName => {
      saved.delete(indexName)
    },
  }
}
