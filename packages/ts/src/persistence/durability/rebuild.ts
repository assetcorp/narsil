import type { IndexMetadata } from '../../types/internal'
import { createDurableDirectory } from './durable-filesystem'
import { type CheckpointSegmentsWritten, writeCheckpointSegments } from './segment'
import type { PartitionCheckpoint } from './snapshot-bundle'

export async function rebuildSegmentsFromDurable(
  root: string,
  metadata: IndexMetadata,
  targets: PartitionCheckpoint[],
  compactionThreshold: number,
): Promise<CheckpointSegmentsWritten> {
  const directory = createDurableDirectory(root)
  return writeCheckpointSegments({ directory, metadata, targets, compactionThreshold })
}
