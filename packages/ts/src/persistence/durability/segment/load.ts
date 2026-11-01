import { ErrorCodes, NarsilError } from '../../../errors'
import type { PartitionManager } from '../../../partitioning/manager'
import type { VectorIndex } from '../../../vector/vector-index'
import type { PartitionCheckpoint } from '../partition-checkpoint'
import type { WriteRecordKeeper } from '../types'
import { manifestKey, segmentsPrefix } from './layout'
import { loadPartitionSegments } from './load-partition'
import type { SegmentManifest } from './manifest'
import { type DecodedManifest, decodeSegmentManifest } from './manifest-decode'
import type { CheckpointStore } from './store'
import { loadVectorField } from './vector-load'

export interface CheckpointLoadDeps {
  manager: PartitionManager
  vectorIndexes: Map<string, VectorIndex>
  writeRecords?: WriteRecordKeeper | null
}

export async function readSegmentManifest(store: CheckpointStore, indexName: string): Promise<DecodedManifest | null> {
  const bytes = await store.read(manifestKey(indexName))
  if (bytes === null) return null
  return decodeSegmentManifest(bytes, indexName)
}

export async function readCurrentManifest(store: CheckpointStore, indexName: string): Promise<SegmentManifest | null> {
  const decoded = await readSegmentManifest(store, indexName)
  if (decoded === null) return null
  if (decoded.kind === 'current') return decoded.manifest
  throw new NarsilError(
    ErrorCodes.PERSISTENCE_SAVE_FAILED,
    `Index "${indexName}" still holds the layout of an earlier release, which recovery upgrades before any checkpoint`,
    { indexName },
  )
}

export function growPartitionsTo(manager: PartitionManager, highestPartitionId: number): void {
  while (manager.partitionCount <= highestPartitionId) {
    const before = manager.partitionCount
    try {
      manager.addPartition()
    } catch {
      break
    }
    if (manager.partitionCount === before) break
  }
}

export async function loadSegmentedCheckpoint(
  store: CheckpointStore,
  indexName: string,
  manifest: SegmentManifest,
  deps: CheckpointLoadDeps,
  decodesEveryDocument = false,
): Promise<PartitionCheckpoint[]> {
  let highestPartitionId = manifest.partitions.length - 1
  for (const partition of manifest.partitions) {
    if (partition.partitionId > highestPartitionId) highestPartitionId = partition.partitionId
  }
  growPartitionsTo(deps.manager, highestPartitionId)

  for (const partition of manifest.partitions) {
    if (partition.partitionId >= deps.manager.partitionCount) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Segment manifest references partition ${partition.partitionId} beyond the partition count ${deps.manager.partitionCount}`,
        { indexName, partitionId: partition.partitionId, partitionCount: deps.manager.partitionCount },
      )
    }
    await loadPartitionSegments(store, partition, deps.manager, {
      schema: manifest.schema,
      decodesEveryDocument,
      writeRecords: deps.writeRecords ?? null,
    })
  }

  for (const vector of manifest.vectors) {
    const vectorIndex = deps.vectorIndexes.get(vector.fieldPath)
    if (vectorIndex === undefined) continue
    await loadVectorField(
      store,
      vector,
      vectorIndex,
      decodesEveryDocument ? null : docId => deps.manager.partitionIdOf(docId),
    )
  }

  return manifest.checkpoint
}

export async function reclaimUnlistedKeys(
  store: CheckpointStore,
  indexName: string,
  referenced: ReadonlySet<string>,
): Promise<void> {
  for (const key of await store.list(segmentsPrefix(indexName))) {
    if (!referenced.has(key)) await store.remove(key)
  }
}
