import type { PartitionManager } from '../partitioning/manager'
import type { IndexConfig } from '../types/schema'
import type { WorkerPool } from '../workers/pool'

export async function transferIndexToPool(
  indexName: string,
  pool: WorkerPool,
  config: IndexConfig,
  manager: PartitionManager,
): Promise<void> {
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
  for (let i = 0; i < manager.partitionCount; i++) {
    const serialized = manager.serializePartition(i)
    await Promise.all(
      allExecutors.map(workerExecutor =>
        workerExecutor.execute({
          type: 'deserialize',
          indexName,
          partitionId: i,
          data: serialized,
          requestId: `resync-${indexName}-${i}`,
        }),
      ),
    )
  }
}
