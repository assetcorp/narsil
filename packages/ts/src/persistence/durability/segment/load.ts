import { ErrorCodes, NarsilError } from '../../../errors'
import type { DurableDirectory } from '../durable-filesystem'
import type { ReplayDeps } from '../recovery'
import type { PartitionCheckpoint } from '../snapshot-bundle'
import { manifestKey, segmentsPrefix, snapshotBundleKey } from './layout'
import { loadPartitionSegmentBySegment } from './load-partition'
import {
  decodeSegmentManifest,
  manifestReferencedKeys,
  type PartitionManifestEntry,
  type SegmentManifest,
} from './manifest'
import { mergeTimeOrderedSegments } from './merge'
import { readSegmentContents, type SegmentContents } from './segment-file'
import { loadVectorField } from './vector'

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

  for (const partition of manifest.partitions) {
    if (partition.partitionId >= deps.manager.partitionCount) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Segment manifest references partition ${partition.partitionId} beyond the partition count ${deps.manager.partitionCount}`,
        { indexName, partitionId: partition.partitionId, partitionCount: deps.manager.partitionCount },
      )
    }
    if (deps.storedTermsAreCurrent === true) {
      await loadPartitionSegmentBySegment(directory, partition, deps.manager)
    } else {
      await loadPartitionWithItsStoredTerms(directory, indexName, partition, deps)
    }
  }

  for (const vector of manifest.vectors) {
    const vectorIndex = deps.vectorIndexes.get(vector.fieldPath)
    if (vectorIndex === undefined) continue
    await loadVectorField(directory, indexName, vector, vectorIndex)
  }

  return manifest.checkpoint
}

async function loadPartitionWithItsStoredTerms(
  directory: DurableDirectory,
  indexName: string,
  partition: PartitionManifestEntry,
  deps: ReplayDeps,
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
}

export async function reclaimOrphanedSegments(
  directory: DurableDirectory,
  indexName: string,
  manifest: SegmentManifest,
): Promise<void> {
  const referenced = manifestReferencedKeys(manifest)
  for (const key of await directory.list(segmentsPrefix(indexName))) {
    if (!referenced.has(key)) await directory.remove(key)
  }
  await directory.remove(snapshotBundleKey(indexName))
}
