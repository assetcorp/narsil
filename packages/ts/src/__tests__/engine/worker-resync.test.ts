import { describe, expect, it } from 'vitest'
import { transferIndexToPool } from '../../engine/worker-resync'
import type { PartitionManager } from '../../partitioning/manager'
import type { Executor } from '../../workers/executor'
import { createWorkerPool, type WorkerPool } from '../../workers/pool'
import type { WorkerAction } from '../../workers/protocol'

interface Recorder {
  pool: WorkerPool
  sentTypes: string[]
  pending: Array<() => void>
}

function recordingPool(): Recorder {
  const sentTypes: string[] = []
  const pending: Array<() => void> = []
  const workerFactory = (): Executor => ({
    execute<T>(action: WorkerAction): Promise<T> {
      sentTypes.push(action.type)
      return new Promise(resolve => {
        pending.push(() => resolve(undefined as T))
      })
    },
    shutdown: () => Promise.resolve(),
  })
  const pool = createWorkerPool({ count: 2, workerFactory })
  pool.spawnAll()
  return { pool, sentTypes, pending }
}

function managerOf(serialised: number[]): PartitionManager {
  return {
    partitionCount: 2,
    getPartition: () => ({}),
    serializePartition(partitionId: number) {
      serialised.push(partitionId)
      return { partitionId }
    },
  } as unknown as PartitionManager
}

async function drain(recorder: Recorder, transfer: Promise<void>): Promise<void> {
  let settled = false
  const watched = transfer.finally(() => {
    settled = true
  })
  for (let round = 0; round < 50 && !settled; round++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    while (recorder.pending.length > 0) recorder.pending.shift()?.()
  }
  await watched
}

describe('transferIndexToPool', () => {
  it('reads every partition of the main copy before any message reaches a worker', async () => {
    const recorder = recordingPool()
    const serialised: number[] = []

    const transfer = transferIndexToPool('prose', recorder.pool, { schema: { title: 'string' } }, managerOf(serialised))

    expect(serialised).toEqual([0, 1])
    expect(recorder.sentTypes).toEqual(['dropIndex', 'dropIndex'])
    await drain(recorder, transfer)
  })

  it('creates the index on every worker and then sends each partition in order', async () => {
    const recorder = recordingPool()

    await drain(recorder, transferIndexToPool('prose', recorder.pool, { schema: { title: 'string' } }, managerOf([])))

    expect(recorder.sentTypes).toEqual([
      'dropIndex',
      'dropIndex',
      'createIndex',
      'createIndex',
      'deserialize',
      'deserialize',
      'deserialize',
      'deserialize',
    ])
  })
})
