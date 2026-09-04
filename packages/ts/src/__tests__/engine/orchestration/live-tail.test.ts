import { describe, expect, it } from 'vitest'
import { isCompositePartition } from '../../../core/partition/composite'
import { LIVE_TAIL_FLUSH_DOCUMENTS } from '../../../engine/orchestration/constants'
import { flushGrownTails } from '../../../engine/orchestration/live-tail'
import type { OrchestratorState } from '../../../engine/orchestration/types'
import type { PartitionManager } from '../../../partitioning/manager'
import type { SchemaDefinition } from '../../../types/schema'
import { createDirectExecutor, type DirectExecutorExtensions } from '../../../workers/direct-executor'
import type { Executor } from '../../../workers/executor'
import type { WorkerAction } from '../../../workers/protocol'
import { emptyOrchestratorState, settle } from './fixtures'

const schema: SchemaDefinition = { title: 'string', score: 'number' }

function liveCount(manager: PartitionManager): number {
  const partition = manager.getPartition(0)
  return isCompositePartition(partition) ? partition.live.count() : partition.count()
}

function frozenCount(manager: PartitionManager): number {
  const partition = manager.getPartition(0)
  return isCompositePartition(partition) ? partition.frozenSegmentCount() : 0
}

async function mainAndCopy(): Promise<{
  state: OrchestratorState
  main: PartitionManager
  copy: PartitionManager
  received: WorkerAction[]
}> {
  const executor = createDirectExecutor()
  const worker: Executor & DirectExecutorExtensions = createDirectExecutor()
  const received: WorkerAction[] = []
  for (const target of [executor, worker]) {
    await target.execute({ type: 'createIndex', indexName: 'products', config: { schema }, requestId: 'create' })
  }
  const main = executor.getManager('products')
  const copy = worker.getManager('products')
  if (!main || !copy) throw new Error('manager missing')
  const recording: Executor = {
    execute<T>(action: WorkerAction): Promise<T> {
      received.push(action)
      return worker.execute<T>(action)
    },
    shutdown: () => worker.shutdown(),
  }
  const state = emptyOrchestratorState({
    executor,
    workersEnabled: true,
    scaledOutIndexes: new Set(['products']),
    workerPool: {
      getExecutor: () => recording,
      getAllExecutors: () => [recording],
      executorsHolding: () => [recording],
      deadWorkerIds: () => [],
      spawnReplacement: () => null,
      leaseLeastBusy: () => ({ workerId: 0, executor: recording, release: () => undefined }),
      leaseIdle: () => [{ workerId: 0, executor: recording, release: () => undefined }],
      queriesInFlight: () => 0,
      spawnAll: () => undefined,
      workerCount: 1,
      addIndex: () => undefined,
      addIndexToAll: () => undefined,
      removeIndex: () => undefined,
      getMemoryStats: async () => [],
      shutdown: async () => undefined,
    },
  })
  return { state, main, copy, received }
}

async function insertOnBoth(
  state: OrchestratorState,
  copy: PartitionManager,
  from: number,
  count: number,
): Promise<void> {
  for (let i = from; i < from + count; i++) {
    const document = { id: `doc-${i}`, title: 'tail entry', score: i }
    await state.executor.execute({
      type: 'insert',
      indexName: 'products',
      docId: document.id,
      document,
      requestId: `m${i}`,
    })
    copy.insert(document.id, document)
    flushGrownTails(state, 'products')
  }
}

describe('freezing a live tail that grows during ingest', () => {
  it('freezes the tail on the main copy once it reaches the flush size and sends the same segment to the copy', async () => {
    const { state, main, copy, received } = await mainAndCopy()

    await insertOnBoth(state, copy, 0, LIVE_TAIL_FLUSH_DOCUMENTS - 1)
    expect(frozenCount(main)).toBe(0)
    expect(received).toEqual([])

    await insertOnBoth(state, copy, LIVE_TAIL_FLUSH_DOCUMENTS - 1, 1)
    expect(frozenCount(main)).toBe(1)
    expect(liveCount(main)).toBe(0)
    await settle()
    expect(received.map(action => action.type)).toEqual(['freezeLiveTail'])
    expect(frozenCount(copy)).toBe(1)
    expect(liveCount(copy)).toBe(0)
    expect(copy.countDocuments()).toBe(LIVE_TAIL_FLUSH_DOCUMENTS)
    expect(copy.get(`doc-${LIVE_TAIL_FLUSH_DOCUMENTS - 1}`)).toMatchObject({ score: LIVE_TAIL_FLUSH_DOCUMENTS - 1 })
  }, 20_000)

  it('holds the freeze back while the copies of the index are loading and sends it once they are in place', async () => {
    const { state, main, copy, received } = await mainAndCopy()
    const buffered: WorkerAction[] = []
    state.copyLoadBuffers.set('products', buffered)

    await insertOnBoth(state, copy, 0, LIVE_TAIL_FLUSH_DOCUMENTS)
    expect(frozenCount(main)).toBe(1)
    expect(received).toEqual([])
    expect(buffered.map(action => action.type)).toEqual(['freezeLiveTail'])
  }, 20_000)
})
