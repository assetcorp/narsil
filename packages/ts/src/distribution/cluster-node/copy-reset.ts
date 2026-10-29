import type { EngineCore } from '../../engine/core'
import { emptySerializablePartition } from '../../engine/worker-resync'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import { checkpointLastSeqNo, checkpointPrimaryTerm } from '../../persistence/durability/partition-checkpoint'
import { reopenPartitionLogAfterReplay, restartPartitionLog } from '../../persistence/durability/partition-log'
import { replaySyncedWal } from '../../persistence/durability/recovery'
import { readSegmentManifest } from '../../persistence/durability/segment/load'
import { loadPartitionSegments } from '../../persistence/durability/segment/load-partition'
import type { SegmentManifest } from '../../persistence/durability/segment/manifest'
import { type CheckpointStore, directoryCheckpointStore } from '../../persistence/durability/segment/store'
import { readVectorFile } from '../../persistence/durability/segment/vector-load'
import { isDead } from '../../vector/vector-index/dead-bits'
import { bytesToVectors } from '../../vector/vector-index/payload'

function clearPartition(manager: PartitionManager, partitionId: number): void {
  const held = [...manager.getPartition(partitionId).docIds()]
  for (const vectorIndex of manager.getVectorIndexes().values()) {
    for (const docId of held) if (vectorIndex.has(docId)) vectorIndex.remove(docId)
  }
  manager.deserializePartition(partitionId, emptySerializablePartition(manager, partitionId))
}

async function withPartitionHeld(core: EngineCore, indexName: string, work: () => Promise<void>): Promise<void> {
  const release = await core.indexState.acquire(indexName, false)
  try {
    const wasScaledOut = core.orchestrator.desyncIndex(indexName)
    try {
      await work()
    } finally {
      await core.orchestrator.resyncIndex(indexName, wasScaledOut)
    }
  } finally {
    release()
  }
}

export async function emptyPartitionCopy(core: EngineCore, indexName: string, partitionId: number): Promise<void> {
  if (!core.indexRegistry.has(indexName)) return
  await withPartitionHeld(core, indexName, async () => clearPartition(core.requireManager(indexName), partitionId))
  const durable = core.durability?.manager
  if (durable !== undefined) await restartPartitionLog(durable, indexName, partitionId, { seqNo: 0, primaryTerm: 0 })
}

async function loadPartitionVectors(
  store: CheckpointStore,
  manifest: SegmentManifest,
  manager: PartitionManager,
  partitionId: number,
): Promise<void> {
  const partition = manager.getPartition(partitionId)
  for (const field of manifest.vectors) {
    const vectorIndex = manager.getVectorIndexes().get(field.fieldPath)
    if (vectorIndex === undefined) continue
    for (const file of field.files) {
      const { payload } = await readVectorFile(store, file, field.fieldPath)
      const vectors = bytesToVectors(payload.vectors)
      for (let i = 0; i < payload.docIds.length; i++) {
        if (isDead(file.dead, i) || !partition.has(payload.docIds[i])) continue
        vectorIndex.insert(
          payload.docIds[i],
          vectors.slice(i * payload.dimension, (i + 1) * payload.dimension),
          partitionId,
        )
      }
    }
    vectorIndex.scheduleBuild()
  }
}

export async function reloadPartitionCopy(core: EngineCore, indexName: string, partitionId: number): Promise<void> {
  const durable = core.durability?.manager
  const registry = durable?.partitionRegistry
  if (durable === undefined || registry === undefined) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Partition ${partitionId} of index "${indexName}" has no files on disk to reload its copy from`,
      { indexName, partitionId },
    )
  }
  await withPartitionHeld(core, indexName, async () => {
    const manager = core.requireManager(indexName)
    clearPartition(manager, partitionId)
    const store = directoryCheckpointStore(registry.directory)
    const decoded = await readSegmentManifest(store, indexName)
    if (decoded !== null && decoded.kind !== 'current') {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Index "${indexName}" holds the checkpoint layout of an earlier release, so partition ${partitionId} cannot reload alone`,
        { indexName, partitionId },
      )
    }
    const manifest = decoded?.manifest ?? null
    const listed = manifest?.partitions.find(entry => entry.partitionId === partitionId)
    if (manifest !== null && listed !== undefined) {
      await loadPartitionSegments(store, listed, manager, { schema: manifest.schema, decodesEveryDocument: true })
      await loadPartitionVectors(store, manifest, manager, partitionId)
    }
    const checkpoint = manifest?.checkpoint ?? []
    await reopenPartitionLogAfterReplay(durable, indexName, partitionId, async () => {
      const replayed = await replaySyncedWal(
        registry.directory,
        indexName,
        partitionId,
        checkpointLastSeqNo(checkpoint, partitionId),
        {
          manager,
          vectorFieldPaths: core.indexRegistry.get(indexName)?.vectorFieldPaths ?? new Set<string>(),
          vectorIndexes: manager.getVectorIndexes(),
        },
      )
      return {
        seqNo: replayed.highestSeqNo,
        primaryTerm: Math.max(checkpointPrimaryTerm(checkpoint, partitionId), replayed.highestPrimaryTerm),
      }
    })
  })
}
