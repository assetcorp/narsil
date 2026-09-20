import type { IndexMetadata } from '../../types/internal'
import { createDurableDirectory } from './durable-filesystem'
import { type SegmentedCheckpointOutcome, type VectorSegmentRef, writeSegmentedCheckpoint } from './segment'
import type { PartitionCheckpoint } from './snapshot-bundle'

export async function rebuildSnapshotFromDurable(
  root: string,
  metadata: IndexMetadata,
  targets: PartitionCheckpoint[],
  compactionThreshold: number,
  vectors?: VectorSegmentRef[],
): Promise<SegmentedCheckpointOutcome> {
  const directory = createDurableDirectory(root)
  return writeSegmentedCheckpoint({ directory, metadata, targets, compactionThreshold, vectors })
}
