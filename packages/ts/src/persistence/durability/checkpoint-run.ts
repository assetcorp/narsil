import { writeMetadataEnvelope } from '../../serialization/envelope'
import type { VectorIndex } from '../../vector/vector-index'
import { reclaimWalBeyondCount, truncateCoveredSegments } from './checkpoint'
import { writeIndexCheckpoint } from './checkpoint-write'
import type { DurableDirectory } from './durable-filesystem'
import type { IndexState } from './manager-state'
import { removeCheckpointGarbage, type VectorCheckpointLayout } from './segment'
import { SINGLE_NODE_PRIMARY_TERM } from './seq-owner'
import type { PartitionCheckpoint } from './snapshot-bundle'
import type { IndexDurabilityHooks } from './types'

interface DurableCheckpointInput {
  directory: DurableDirectory
  hooks: IndexDurabilityHooks
  indexName: string
  indexState: IndexState
  compactionThreshold: number
  canOffload: boolean
  fromMemory: boolean
  queueMetadataWrite(indexName: string, write: () => Promise<void>): Promise<void>
  markFatal(error: Error): void
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function adoptVectorLayouts(
  directory: DurableDirectory,
  vectorIndexes: Map<string, VectorIndex>,
  layouts: readonly VectorCheckpointLayout[],
): Promise<void> {
  for (const layout of layouts) {
    const vecIndex = vectorIndexes.get(layout.fieldPath)
    if (vecIndex === undefined || vecIndex.storage !== 'disk') continue
    const path = await directory.pathOf(layout.key)
    await vecIndex.adoptDiskLayout({ path, docIds: layout.docIds, vectorsOffset: layout.vectorsOffset })
  }
}

/**
 * Writes a durable checkpoint and reclaims the WAL data it covers.
 *
 * @param input - The index state, durability hooks, and storage settings for the checkpoint.
 * @returns A promise that settles after metadata and WAL cleanup finish.
 */
export async function runDurableCheckpoint(input: DurableCheckpointInput): Promise<void> {
  const manager = input.hooks.getManager(input.indexName)
  if (manager === undefined) {
    return
  }
  const metadata = input.hooks.buildMetadata(input.indexName)
  if (metadata === undefined) {
    return
  }

  const targets: PartitionCheckpoint[] = []
  const documentCount = manager.countDocuments()
  for (let i = 0; i < manager.partitionCount; i += 1) {
    const partition = input.indexState.partitions.get(i)
    targets.push({
      partitionId: i,
      lastSeqNo: partition?.appliedSeqNo ?? 0,
      primaryTerm: partition?.seqOwner.primaryTerm ?? SINGLE_NODE_PRIMARY_TERM,
    })
  }
  for (let i = 0; i < manager.partitionCount; i += 1) {
    const partition = input.indexState.partitions.get(i)
    if (partition === undefined) {
      continue
    }
    try {
      await partition.walWriter.commit()
    } catch (error) {
      partition.failed = toError(error)
      input.markFatal(partition.failed)
      throw partition.failed
    }
  }

  const written = await writeIndexCheckpoint({
    directory: input.directory,
    metadata,
    targets,
    compactionThreshold: input.compactionThreshold,
    manager,
    canOffload: input.canOffload,
    fromMemory: input.fromMemory,
  })
  await adoptVectorLayouts(input.directory, input.hooks.getVectorIndexes(input.indexName), written.vectorLayouts)
  await removeCheckpointGarbage(input.directory, written.garbage)
  const checkpointDocumentCount = written.documentCount ?? documentCount
  await input.queueMetadataWrite(input.indexName, async () => {
    const checkpointMetadata = input.hooks.buildMetadata(input.indexName, checkpointDocumentCount)
    if (checkpointMetadata === undefined) {
      return
    }
    const bytes = await writeMetadataEnvelope(checkpointMetadata, { checksum: true })
    await input.directory.atomicWrite(`${input.indexName}/meta`, bytes)
    input.hooks.recordCheckpoint?.(input.indexName, checkpointDocumentCount, manager.partitionCount)
  })
  await truncateCoveredSegments(input.directory, input.indexName, targets)
  await reclaimWalBeyondCount(
    input.directory,
    input.indexName,
    manager.partitionCount,
    input.indexState.partitions,
    input.markFatal,
  )
  input.indexState.mutationsSinceCheckpoint = 0
}
