import type { IndexMetadata } from '../../types/internal'
import { runCheckpointOnWorker } from './checkpoint-worker-dispatch'
import type { DurableDirectory } from './durable-filesystem'
import {
  type SegmentedCheckpointOutcome,
  type VectorSegmentRef,
  type WholePartitionSegment,
  writeSegmentedCheckpoint,
} from './segment'
import type { PartitionCheckpoint } from './snapshot-bundle'

export interface IndexCheckpointWrite {
  directory: DurableDirectory
  metadata: IndexMetadata
  targets: PartitionCheckpoint[]
  compactionThreshold: number
  canOffload: boolean
  wholePartitions: ReadonlyMap<number, WholePartitionSegment>
  vectors: VectorSegmentRef[]
}

/**
 * Writes one index checkpoint in a worker or in the current process.
 *
 * @param input - The checkpoint target, the partitions already serialised
 * from memory, and the storage settings.
 * @returns What the checkpoint wrote. A worker builds every segment from the
 * log, so the write stays in the current process once any partition arrives
 * already serialised.
 */
export async function writeIndexCheckpoint(input: IndexCheckpointWrite): Promise<SegmentedCheckpointOutcome> {
  const { directory, metadata, targets, compactionThreshold, wholePartitions, vectors } = input

  const offloaded =
    wholePartitions.size === 0 &&
    input.canOffload &&
    metadata.tokenizer === undefined &&
    metadata.stopWords === undefined
      ? await runCheckpointOnWorker({ root: directory.root, metadata, targets, compactionThreshold, vectors })
      : null

  if (offloaded !== null) {
    return offloaded
  }

  return writeSegmentedCheckpoint({ directory, metadata, targets, compactionThreshold, vectors, wholePartitions })
}
