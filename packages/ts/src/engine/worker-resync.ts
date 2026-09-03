import { isCompositePartition } from '../core/partition/composite'
import { type SharedFrozenSegment, shareFrozenSegment } from '../core/partition/frozen/share'
import type { PartitionManager } from '../partitioning/manager'
import type { SerializablePartition } from '../types/internal'
import type { IndexConfig } from '../types/schema'
import type { Executor } from '../workers/executor'
import type { WorkerPool } from '../workers/pool'

interface CapturedPartition {
  partitionId: number
  live: SerializablePartition
  frozen: SharedFrozenSegment[]
}

function captureComposite(manager: PartitionManager, partitionId: number): CapturedPartition | null {
  const partition = manager.getPartition(partitionId)
  if (!isCompositePartition(partition)) return null
  const segmentIds = partition.frozenSegmentSizes().map(size => size.segmentId)
  const frozen: SharedFrozenSegment[] = []
  for (const segment of partition.frozenSegmentsById(segmentIds)) {
    const shared = shareFrozenSegment(segment)
    if (shared === null) return null
    frozen.push(shared)
  }
  const live = partition.live.serialize(
    manager.indexName,
    manager.partitionCount,
    manager.language.name,
    manager.schema,
  )
  return { partitionId, live, frozen }
}

function capturePartitions(manager: PartitionManager): CapturedPartition[] {
  const captured: CapturedPartition[] = []
  for (let partitionId = 0; partitionId < manager.partitionCount; partitionId++) {
    captured.push(
      captureComposite(manager, partitionId) ?? {
        partitionId,
        live: manager.serializePartition(partitionId),
        frozen: [],
      },
    )
  }
  return captured
}

async function sendPartition(indexName: string, executors: Executor[], captured: CapturedPartition): Promise<void> {
  await Promise.all(
    executors.map(workerExecutor =>
      workerExecutor.execute({
        type: 'deserialize',
        indexName,
        partitionId: captured.partitionId,
        data: captured.live,
        requestId: `resync-${indexName}-${captured.partitionId}`,
      }),
    ),
  )
  if (captured.frozen.length === 0) return
  const segments = captured.frozen.map(shared => ({
    partitionId: captured.partitionId,
    snapshot: shared.snapshot,
    tombstonedDocIds: shared.tombstonedDocIds,
  }))
  await Promise.all(
    executors.map(workerExecutor =>
      workerExecutor.execute({
        type: 'attachSegments',
        indexName,
        segments,
        requestId: `resync-attach-${indexName}-${captured.partitionId}`,
      }),
    ),
  )
}

/**
 * Loads a copy of one index onto every worker of the pool from what the main
 * copy holds at the moment of the call.
 *
 * This reads the main copy in one synchronous span before any message reaches
 * a worker, so a write that arrives while the workers load reaches them
 * through the replication queue alone. A
 * frozen segment travels as shared memory where the runtime offers it, and
 * the live tail of each partition travels serialised.
 *
 * @param indexName - The index to copy.
 * @param pool - The worker pool that receives the copies.
 * @param config - The index configuration each worker creates the index from.
 * @param manager - The main copy to read.
 */
export async function transferIndexToPool(
  indexName: string,
  pool: WorkerPool,
  config: IndexConfig,
  manager: PartitionManager,
): Promise<void> {
  const captured = capturePartitions(manager)
  const allExecutors = pool.getAllExecutors()
  await Promise.allSettled(
    allExecutors.map(workerExecutor =>
      workerExecutor.execute({ type: 'dropIndex', indexName, requestId: `resync-drop-${indexName}` }),
    ),
  )
  pool.addIndexToAll(indexName)
  await Promise.all(
    allExecutors.map(workerExecutor =>
      workerExecutor.execute({
        type: 'createIndex',
        indexName,
        config,
        requestId: `resync-create-${indexName}`,
      }),
    ),
  )
  for (const partition of captured) {
    await sendPartition(indexName, allExecutors, partition)
  }
}
