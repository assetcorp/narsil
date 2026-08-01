import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { unpackEnvelopeBytes } from '../../../serialization/envelope'
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
import { mergeTimeOrderedSegments } from './merge'
import { readSegmentContents, type SegmentContents } from './segment-file'

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

  const payloadsByField = new Map<string, VectorIndexPayload[]>()
  for (const partition of manifest.partitions) {
    if (partition.partitionId >= deps.manager.partitionCount) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Segment manifest references partition ${partition.partitionId} beyond the partition count ${deps.manager.partitionCount}`,
        { indexName, partitionId: partition.partitionId, partitionCount: deps.manager.partitionCount },
      )
    }
    await loadPartition(directory, indexName, partition, deps, payloadsByField)
  }

  restoreVectorIndexes(payloadsByField, deps)

  return manifest.checkpoint
}

async function loadPartition(
  directory: DurableDirectory,
  indexName: string,
  partition: PartitionManifestEntry,
  deps: ReplayDeps,
  payloadsByField: Map<string, VectorIndexPayload[]>,
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
    const payload = await readVectorSegment(directory, indexName, partition, vector.fieldPath, vector.key)
    const collected = payloadsByField.get(vector.fieldPath)
    if (collected === undefined) {
      payloadsByField.set(vector.fieldPath, [payload])
    } else {
      collected.push(payload)
    }
  }
}

async function readVectorSegment(
  directory: DurableDirectory,
  indexName: string,
  partition: PartitionManifestEntry,
  fieldPath: string,
  key: string,
): Promise<VectorIndexPayload> {
  const bytes = await directory.read(key)
  if (bytes === null) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Segment manifest references a missing vector segment "${key}"`,
      { indexName, partitionId: partition.partitionId, fieldPath, key },
    )
  }
  const { payloadBytes } = await unpackEnvelopeBytes(bytes)
  return decode(payloadBytes) as VectorIndexPayload
}

function restoreVectorIndexes(payloadsByField: Map<string, VectorIndexPayload[]>, deps: ReplayDeps): void {
  for (const [fieldPath, payloads] of payloadsByField) {
    const vecIndex = deps.vectorIndexes.get(fieldPath)
    if (vecIndex === undefined) {
      continue
    }
    vecIndex.deserialize(payloads.length === 1 ? payloads[0] : mergePartitionPayloads(payloads))
  }
}

function mergePartitionPayloads(payloads: VectorIndexPayload[]): VectorIndexPayload {
  const vectors: VectorIndexPayload['vectors'] = []
  const graphs: VectorIndexPayload['graphs'] = []
  for (const payload of payloads) {
    for (const entry of payload.vectors) {
      vectors.push(entry)
    }
    for (const graph of payload.graphs) {
      graphs.push(graph)
    }
  }
  return { fieldName: payloads[0].fieldName, dimension: payloads[0].dimension, vectors, graphs, sq8: null }
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
