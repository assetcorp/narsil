import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { unpackEnvelopeBytes } from '../../../serialization/envelope'
import { deserializePayloadV2 } from '../../../serialization/payload-v2'
import type { SerializablePartition } from '../../../types/internal'
import type { VectorIndexPayload } from '../../../vector/vector-index'
import type { DurableDirectory } from '../durable-filesystem'
import type { ReplayDeps } from '../recovery'
import type { PartitionCheckpoint } from '../snapshot-bundle'
import { legacySnapshotKey, manifestKey, segmentPrefix } from './layout'
import {
  decodeSegmentManifest,
  manifestReferencedKeys,
  type PartitionManifestEntry,
  type SegmentManifest,
} from './manifest'
import { mergeBucketPartitions } from './merge'

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
    await loadPartition(directory, indexName, partition, deps)
  }

  return manifest.checkpoint
}

async function loadPartition(
  directory: DurableDirectory,
  indexName: string,
  partition: PartitionManifestEntry,
  deps: ReplayDeps,
): Promise<void> {
  const decoded: SerializablePartition[] = []
  for (const bucket of partition.buckets) {
    const bytes = await directory.read(bucket.key)
    if (bytes === null) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Segment manifest references a missing bucket segment "${bucket.key}"`,
        { indexName, partitionId: partition.partitionId, bucketId: bucket.bucketId, key: bucket.key },
      )
    }
    decoded.push(deserializePayloadV2(await unwrapSegment(bytes)))
  }

  const merged = mergeBucketPartitions(decoded, {
    indexName,
    partitionId: partition.partitionId,
    totalPartitions: deps.manager.partitionCount,
    language: deps.manager.language.name,
  })
  deps.manager.deserializePartition(partition.partitionId, merged)

  for (const vector of partition.vectors) {
    await loadVectorSegment(directory, indexName, partition, vector.fieldPath, vector.key, deps)
  }
}

async function loadVectorSegment(
  directory: DurableDirectory,
  indexName: string,
  partition: PartitionManifestEntry,
  fieldPath: string,
  key: string,
  deps: ReplayDeps,
): Promise<void> {
  const vecIndex = deps.vectorIndexes.get(fieldPath)
  if (vecIndex === undefined) {
    return
  }
  const bytes = await directory.read(key)
  if (bytes === null) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Segment manifest references a missing vector segment "${key}"`,
      { indexName, partitionId: partition.partitionId, fieldPath, key },
    )
  }
  vecIndex.deserialize(await decodeVectorSegment(bytes))
}

async function unwrapSegment(bytes: Uint8Array): Promise<Uint8Array> {
  const { payloadBytes } = await unpackEnvelopeBytes(bytes)
  return payloadBytes
}

async function decodeVectorSegment(bytes: Uint8Array): Promise<VectorIndexPayload> {
  const { payloadBytes } = await unpackEnvelopeBytes(bytes)
  return decode(payloadBytes) as VectorIndexPayload
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
  await directory.remove(legacySnapshotKey(indexName))
}
