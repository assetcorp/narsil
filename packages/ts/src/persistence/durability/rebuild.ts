import type { IndexMetadata } from '../../types/internal'
import { createDurableDirectory } from './durable-filesystem'
import { writeSegmentedCheckpoint } from './segment'
import type { PartitionCheckpoint } from './snapshot-bundle'

export async function rebuildSnapshotFromDurable(
  root: string,
  metadata: IndexMetadata,
  targets: PartitionCheckpoint[],
  initialBucketCount: number,
  targetBucketBytes: number,
): Promise<void> {
  const directory = createDurableDirectory(root)
  await writeSegmentedCheckpoint({ directory, metadata, targets, initialBucketCount, targetBucketBytes })
}
