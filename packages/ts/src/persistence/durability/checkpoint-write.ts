import type { IndexMetadata } from '../../types/internal'
import { runCheckpointOnWorker } from './checkpoint-worker-dispatch'
import type { DurableDirectory } from './durable-filesystem'
import { type CheckpointSegmentsWritten, type WholePartitionSegment, writeCheckpointSegments } from './segment'
import type { PartitionCheckpoint } from './snapshot-bundle'

export interface IndexCheckpointSegmentsWrite {
  directory: DurableDirectory
  metadata: IndexMetadata
  targets: PartitionCheckpoint[]
  compactionThreshold: number
  canOffload: boolean
  wholePartitions: ReadonlyMap<number, WholePartitionSegment>
}

/**
 * Writes the document segments of one index checkpoint in a worker or in the current process.
 *
 * @param input - The checkpoint target, the partitions already serialised
 * from memory, and the storage settings.
 * @returns The segments that the manifest of this checkpoint must list. A worker builds every
 * segment from the log, so the write stays in the current process once any partition arrives
 * already serialised.
 */
export async function writeIndexCheckpointSegments(
  input: IndexCheckpointSegmentsWrite,
): Promise<CheckpointSegmentsWritten> {
  const { directory, metadata, targets, compactionThreshold, wholePartitions } = input

  const offloaded =
    wholePartitions.size === 0 &&
    input.canOffload &&
    metadata.tokenizer === undefined &&
    metadata.stopWords === undefined
      ? await runCheckpointOnWorker({ root: directory.root, metadata, targets, compactionThreshold })
      : null

  if (offloaded !== null) {
    return offloaded
  }

  return writeCheckpointSegments({ directory, metadata, targets, compactionThreshold, wholePartitions })
}
