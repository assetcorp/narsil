import { enqueuePartitionWrite, type PartitionWriteQueues } from './write-routing/partition-queue'

export interface CopyDiskWork {
  run(indexName: string, partitionId: number, work: () => Promise<void>): Promise<boolean>
  guard(work: () => Promise<void>): Promise<boolean>
  settled(): Promise<void>
}

export function createCopyDiskWork(queues: PartitionWriteQueues, isShutdown: () => boolean): CopyDiskWork {
  const running = new Set<Promise<void>>()

  async function guard(work: () => Promise<void>): Promise<boolean> {
    if (isShutdown()) return false
    const started = work()
    const settled = started.catch(() => undefined)
    running.add(settled)
    try {
      await started
    } finally {
      running.delete(settled)
    }
    return true
  }

  return {
    run(indexName, partitionId, work) {
      return enqueuePartitionWrite(queues, indexName, partitionId, () => guard(work))
    },
    guard,
    async settled() {
      await Promise.all([...running])
    },
  }
}
