import type { IndexMetadata } from '../../types/internal'
import { runCheckpointOnWorker } from './checkpoint-worker-dispatch'
import type { DurableDirectory } from './durable-filesystem'
import {
  type CapturedWholePartition,
  type CheckpointSegmentsWritten,
  type WholePartitionSegment,
  writeCheckpointSegments,
} from './segment'
import type { PartitionCheckpoint } from './snapshot-bundle'

export interface IndexCheckpointSegmentsWrite {
  directory: DurableDirectory
  metadata: IndexMetadata
  targets: PartitionCheckpoint[]
  compactionThreshold: number
  canOffload: boolean
  wholePartitions: ReadonlyMap<number, WholePartitionSegment>
  capturedPartitions: readonly CapturedWholePartition[]
}

function workerCanWriteEverySegment(input: IndexCheckpointSegmentsWrite): boolean {
  if (!input.canOffload || input.wholePartitions.size > 0) return false
  const analysesTextInProcessOnly = input.metadata.tokenizer !== undefined || input.metadata.stopWords !== undefined
  if (!analysesTextInProcessOnly) return true
  return input.targets.every(target =>
    input.capturedPartitions.some(captured => captured.partitionId === target.partitionId),
  )
}

/**
 * Writes the document segments of one index checkpoint in a worker or in the current process.
 *
 * @param input - The checkpoint target, the partitions already serialised
 * from memory, the partitions captured for a worker to serialise, and the storage settings.
 * @returns The segments that the manifest of this checkpoint must list. A worker builds a
 * segment from the log or from a captured partition, so the write stays in the current
 * process once any partition arrives already serialised, and it returns there when the
 * worker fails.
 */
export async function writeIndexCheckpointSegments(
  input: IndexCheckpointSegmentsWrite,
): Promise<CheckpointSegmentsWritten> {
  const { directory, metadata, targets, compactionThreshold, wholePartitions, capturedPartitions } = input

  const offloaded = workerCanWriteEverySegment(input)
    ? await runCheckpointOnWorker({
        root: directory.root,
        metadata,
        targets,
        compactionThreshold,
        capturedPartitions: [...capturedPartitions],
      })
    : null

  if (offloaded !== null) {
    return offloaded
  }

  return writeCheckpointSegments({
    directory,
    metadata,
    targets,
    compactionThreshold,
    wholePartitions,
    capturedPartitions,
  })
}
