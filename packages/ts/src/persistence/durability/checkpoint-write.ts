import type { PartitionManager } from '../../partitioning/manager'
import type { IndexMetadata } from '../../types/internal'
import { runCheckpointOnWorker } from './checkpoint-worker-dispatch'
import type { DurableDirectory } from './durable-filesystem'
import { type SegmentedCheckpointOutcome, writeSegmentedCheckpoint } from './segment'
import type { PartitionCheckpoint } from './snapshot-bundle'

export interface IndexCheckpointWrite {
  directory: DurableDirectory
  metadata: IndexMetadata
  targets: PartitionCheckpoint[]
  compactionThreshold: number
  manager: PartitionManager
  canOffload: boolean
  fromMemory: boolean
}

/**
 * Writes one index checkpoint in a worker or in the current process.
 *
 * @param input - The checkpoint target, index state, and storage settings.
 * @returns What the checkpoint wrote. Its document count holds a number when
 * the write serialises whole partitions from memory, and null when the write
 * builds incremental segments from the log.
 */
export async function writeIndexCheckpoint(input: IndexCheckpointWrite): Promise<SegmentedCheckpointOutcome> {
  const { directory, metadata, targets, compactionThreshold, manager } = input

  const offloaded =
    !input.fromMemory && input.canOffload && metadata.tokenizer === undefined && metadata.stopWords === undefined
      ? await runCheckpointOnWorker({ root: directory.root, metadata, targets, compactionThreshold })
      : null

  if (offloaded !== null) {
    return offloaded
  }

  return writeSegmentedCheckpoint({
    directory,
    metadata,
    targets,
    compactionThreshold,
    ...(input.fromMemory
      ? {
          wholePartitionPayload: (partitionId: number) => ({
            payload: manager.serializePartitionToBytes(partitionId),
            docCount: manager.getPartition(partitionId).count(),
          }),
        }
      : {}),
  })
}
