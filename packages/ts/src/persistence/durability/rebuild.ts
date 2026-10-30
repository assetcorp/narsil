import type { IndexMetadata } from '../../types/internal'
import { createDurableDirectory } from './durable-filesystem'
import type { PartitionCheckpoint } from './partition-checkpoint'
import type { CapturedWholePartition } from './segment/captured-partition'
import { directoryCheckpointStore } from './segment/store'
import { type CheckpointSegmentsWritten, type PriorCheckpoint, writeCheckpointSegments } from './segment/write'

export async function rebuildSegmentsFromDurable(
  root: string,
  metadata: IndexMetadata,
  targets: PartitionCheckpoint[],
  compactionThreshold: number,
  prior: PriorCheckpoint | null,
  capturedPartitions: readonly CapturedWholePartition[] = [],
  keepsWriteRecords = false,
): Promise<CheckpointSegmentsWritten> {
  const directory = createDurableDirectory(root)
  return writeCheckpointSegments({
    store: directoryCheckpointStore(directory),
    directory,
    metadata,
    targets,
    compactionThreshold,
    prior,
    capturedPartitions,
    keepsWriteRecords,
  })
}
