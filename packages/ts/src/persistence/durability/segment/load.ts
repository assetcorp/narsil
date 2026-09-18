import { ErrorCodes, NarsilError } from '../../../errors'
import type { DurableDirectory } from '../durable-filesystem'
import type { ReplayDeps } from '../recovery'
import type { PartitionCheckpoint } from '../snapshot-bundle'
import { manifestKey, segmentPrefix, snapshotBundleKey } from './layout'
import {
  decodeSegmentManifest,
  manifestReferencedKeys,
  type PartitionManifestEntry,
  type SegmentManifest,
} from './manifest'
import { mergeTimeOrderedSegments } from './merge'
import { readSegmentContents, type SegmentContents } from './segment-file'
import { readVectorParts, type VectorPartsRead } from './vector'

export async function readSegmentManifest(
  directory: DurableDirectory,
  indexName: string,
): Promise<SegmentManifest | null> {
  const bytes = await directory.read(manifestKey(indexName))
  if (bytes === null) {
    return null
  }
  return decodeSegmentManifest(bytes)
}

export async function loadSegmentedSnapshot(
  directory: DurableDirectory,
  indexName: string,
  manifest: SegmentManifest,
  deps: ReplayDeps,
): Promise<PartitionCheckpoint[]> {
  let highestPartitionId = manifest.partitions.length - 1
  for (const partition of manifest.partitions) {
    if (partition.partitionId > highestPartitionId) {
      highestPartitionId = partition.partitionId
    }
  }
  while (deps.manager.partitionCount <= highestPartitionId) {
    const before = deps.manager.partitionCount
    try {
      deps.manager.addPartition()
    } catch {
      break
    }
    if (deps.manager.partitionCount === before) {
      break
    }
  }

  const partsByField = new Map<string, VectorPartsRead>()
  for (const partition of manifest.partitions) {
    if (partition.partitionId >= deps.manager.partitionCount) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Segment manifest references partition ${partition.partitionId} beyond the partition count ${deps.manager.partitionCount}`,
        { indexName, partitionId: partition.partitionId, partitionCount: deps.manager.partitionCount },
      )
    }
    await loadPartition(directory, indexName, partition, deps, partsByField)
  }

  for (const [fieldPath, read] of partsByField) {
    deps.vectorIndexes.get(fieldPath)?.deserialize(read.parts, read.files)
  }

  return manifest.checkpoint
}

async function loadPartition(
  directory: DurableDirectory,
  indexName: string,
  partition: PartitionManifestEntry,
  deps: ReplayDeps,
  partsByField: Map<string, VectorPartsRead>,
): Promise<void> {
  const ordered: SegmentContents[] = []
  for (const segment of partition.segments) {
    ordered.push(await readSegmentContents(directory, segment.key))
  }

  const merged = mergeTimeOrderedSegments(ordered, {
    indexName,
    partitionId: partition.partitionId,
    totalPartitions: deps.manager.partitionCount,
    language: deps.manager.language.name,
  })
  deps.manager.deserializePartition(partition.partitionId, merged)

  for (const vector of partition.vectors) {
    if (!deps.vectorIndexes.has(vector.fieldPath)) {
      continue
    }
    const read = await readVectorParts(directory, vector.keys)
    const collected = partsByField.get(vector.fieldPath)
    if (collected === undefined) {
      partsByField.set(vector.fieldPath, read)
    } else {
      collected.parts.push(...read.parts)
      collected.files.push(...read.files)
    }
  }
}

export async function reclaimOrphanedSegments(
  directory: DurableDirectory,
  indexName: string,
  manifest: SegmentManifest,
): Promise<void> {
  const referenced = manifestReferencedKeys(manifest)
  for (const partition of manifest.partitions) {
    const prefix = segmentPrefix(indexName, partition.partitionId)
    for (const key of await directory.list(prefix)) {
      if (!referenced.has(key)) {
        await directory.remove(key)
      }
    }
  }
  await directory.remove(snapshotBundleKey(indexName))
}
