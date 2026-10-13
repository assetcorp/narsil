import type { IndexMetadata } from '../../types/internal'
import { runCheckpointOnWorker } from './checkpoint-worker-dispatch'
import type { DurableDirectory } from './durable-filesystem'
import type { PartitionCheckpoint } from './partition-checkpoint'
import type { CapturedWholePartition, PartitionContents } from './segment/captured-partition'
import { directoryCheckpointStore } from './segment/store'
import { type CheckpointSegmentsWritten, type PriorCheckpoint, writeCheckpointSegments } from './segment/write'

export interface IndexCheckpointSegmentsWrite {
  directory: DurableDirectory
  metadata: IndexMetadata
  targets: PartitionCheckpoint[]
  compactionThreshold: number
  canOffload: boolean
  prior: PriorCheckpoint | null
  wholePartitions: readonly PartitionContents[]
  capturedPartitions: readonly CapturedWholePartition[]
}

function workerCanWriteEverySegment(input: IndexCheckpointSegmentsWrite): boolean {
  if (!input.canOffload || input.wholePartitions.length > 0) return false
  const analysesTextInProcessOnly = input.metadata.tokenizer !== undefined || input.metadata.stopWords !== undefined
  if (!analysesTextInProcessOnly) return true
  return input.targets.every(target =>
    input.capturedPartitions.some(captured => captured.partitionId === target.partitionId),
  )
}

export async function writeIndexCheckpointSegments(
  input: IndexCheckpointSegmentsWrite,
): Promise<CheckpointSegmentsWritten> {
  const { directory, metadata, targets, compactionThreshold, prior, wholePartitions, capturedPartitions } = input

  const offloaded = workerCanWriteEverySegment(input)
    ? await runCheckpointOnWorker({
        root: directory.root,
        metadata,
        targets,
        compactionThreshold,
        prior,
        capturedPartitions: [...capturedPartitions],
      })
    : null

  if (offloaded !== null) {
    return offloaded
  }

  return writeCheckpointSegments({
    store: directoryCheckpointStore(directory),
    directory,
    metadata,
    targets,
    compactionThreshold,
    prior,
    wholePartitions,
    capturedPartitions,
  })
}
