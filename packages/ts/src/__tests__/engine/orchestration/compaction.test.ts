import { describe, expect, it } from 'vitest'
import { createPartitionIndex } from '../../../core/partition'
import { isCompositePartition } from '../../../core/partition/composite'
import { createFrozenSegment } from '../../../core/partition/frozen'
import type { SegmentPayload } from '../../../core/partition/segment-payload'
import {
  awaitCompactions,
  IDLE_MERGE_DELAY_MS,
  maybeCompactSegments,
  scheduleIdleMerge,
} from '../../../engine/orchestration/compaction'
import { LIVE_TAIL_FREEZE_FLOOR } from '../../../engine/orchestration/live-tail'
import type { OrchestratorState } from '../../../engine/orchestration/types'
import type { PartitionManager } from '../../../partitioning/manager'
import type { AnyDocument, SchemaDefinition } from '../../../types/schema'
import { createDirectExecutor } from '../../../workers/direct-executor'
import { english } from '../../core/partition-index/fixtures'
import { emptyOrchestratorState } from './fixtures'

const schema: SchemaDefinition = { title: 'string', score: 'number' }

function segmentFor(marker: string, count: number): { payload: SegmentPayload; documents: AnyDocument[] } {
  const documents = Array.from({ length: count }, (_, i) => ({
    id: `${marker}-${i}`,
    title: `${marker} shared entry`,
    score: i,
  }))
  const scratch = createPartitionIndex(0)
  for (const doc of documents) {
    scratch.insert(String(doc.id), doc, schema, english)
  }
  return { payload: scratch.encodeSegment(), documents }
}

async function mainThreadIndex(segmentCount: number): Promise<{ state: OrchestratorState; manager: PartitionManager }> {
  const executor = createDirectExecutor()
  await executor.execute({ type: 'createIndex', indexName: 'products', config: { schema }, requestId: 'create' })
  const manager = executor.getManager('products')
  if (!manager) throw new Error('manager missing')
  for (let s = 0; s < segmentCount; s++) {
    const { payload, documents } = segmentFor(`seg${s}`, 4 + s)
    manager.attachFrozenSegment(0, createFrozenSegment(payload, documents))
  }
  return { state: emptyOrchestratorState({ executor }), manager }
}

function frozenCount(manager: PartitionManager): number {
  const partition = manager.getPartition(0)
  return isCompositePartition(partition) ? partition.frozenSegmentCount() : 0
}

describe('segment compaction during loading', () => {
  it('folds a partition holding eight frozen segments into one on the main thread', async () => {
    const { state, manager } = await mainThreadIndex(8)
    const total = manager.countDocuments()

    maybeCompactSegments(state, 'products')
    await awaitCompactions(state)

    expect(frozenCount(manager)).toBe(1)
    expect(manager.countDocuments()).toBe(total)
    expect(manager.has('seg0-0')).toBe(true)
    expect(manager.has('seg7-10')).toBe(true)
    expect(manager.get('seg3-2')).toMatchObject({ title: 'seg3 shared entry' })
  })

  it('leaves a partition holding fewer than eight segments alone', async () => {
    const { state, manager } = await mainThreadIndex(3)

    maybeCompactSegments(state, 'products')
    await awaitCompactions(state)

    expect(frozenCount(manager)).toBe(3)
  })
})

describe('segment merge once the index is idle', () => {
  it('freezes the live tail and merges every segment into one on the main copy and the worker copy once no write has arrived for the idle delay', async () => {
    const { state, manager } = await mainThreadIndex(3)
    const worker = createDirectExecutor()
    await worker.execute({ type: 'createIndex', indexName: 'products', config: { schema }, requestId: 'create' })
    const copy = worker.getManager('products')
    if (!copy) throw new Error('copy missing')
    const partition = manager.getPartition(0)
    if (!isCompositePartition(partition)) throw new Error('main copy holds no segments')
    const segmentIds = partition.frozenSegmentSizes().map(size => size.segmentId)
    for (const segment of partition.frozenSegmentsById(segmentIds)) {
      copy.attachFrozenSegment(0, segment)
    }
    for (let i = 0; i < LIVE_TAIL_FREEZE_FLOOR; i++) {
      const document = { id: `tail-${i}`, title: 'tail shared entry', score: 100 + i }
      await state.executor.execute({
        type: 'insert',
        indexName: 'products',
        docId: document.id,
        document,
        requestId: `m${i}`,
      })
      await worker.execute({ type: 'insert', indexName: 'products', docId: document.id, document, requestId: `w${i}` })
    }
    const copyPartition = copy.getPartition(0)
    if (!isCompositePartition(copyPartition)) throw new Error('copy holds no segments')
    expect(partition.live.count()).toBe(LIVE_TAIL_FREEZE_FLOOR)
    expect(copyPartition.live.count()).toBe(LIVE_TAIL_FREEZE_FLOOR)
    state.workerPool = {
      getExecutor: () => worker,
      getAllExecutors: () => [worker],
      executorsHolding: () => [worker],
      deadWorkerIds: () => [],
      spawnReplacement: () => null,
      leaseLeastBusy: () => ({ workerId: 0, executor: worker, release: () => undefined }),
      leaseIdle: () => [{ workerId: 0, executor: worker, release: () => undefined }],
      queriesInFlight: () => 0,
      spawnAll: () => undefined,
      workerCount: 1,
      addIndex: () => undefined,
      addIndexToAll: () => undefined,
      removeIndex: () => undefined,
      getMemoryStats: async () => [],
      shutdown: async () => undefined,
    }
    state.scaledOutIndexes.add('products')

    scheduleIdleMerge(state, 'products')
    await new Promise(resolve => setTimeout(resolve, IDLE_MERGE_DELAY_MS + 50))
    await awaitCompactions(state)

    expect(frozenCount(manager)).toBe(1)
    expect(frozenCount(copy)).toBe(1)
    expect(partition.live.count()).toBe(0)
    expect(copyPartition.live.count()).toBe(0)
    expect(copy.countDocuments()).toBe(manager.countDocuments())
    expect(copy.has('seg2-5')).toBe(true)
    expect(copy.has('tail-3')).toBe(true)
    expect(copy.get('tail-3')).toMatchObject({ title: 'tail shared entry', score: 103 })
  })

  it('does nothing on an index whose copies have been given up', async () => {
    const { state, manager } = await mainThreadIndex(3)

    scheduleIdleMerge(state, 'products')
    await new Promise(resolve => setTimeout(resolve, IDLE_MERGE_DELAY_MS + 50))
    await awaitCompactions(state)

    expect(frozenCount(manager)).toBe(3)
  })

  it('restarts the idle delay on every write', async () => {
    const { state, manager } = await mainThreadIndex(3)
    state.scaledOutIndexes.add('products')

    scheduleIdleMerge(state, 'products')
    await new Promise(resolve => setTimeout(resolve, IDLE_MERGE_DELAY_MS / 2))
    scheduleIdleMerge(state, 'products')
    await new Promise(resolve => setTimeout(resolve, IDLE_MERGE_DELAY_MS / 2 + 50))

    expect(state.idleMergeTimers.has('products')).toBe(true)
    expect(frozenCount(manager)).toBe(3)
    for (const timer of state.idleMergeTimers.values()) clearTimeout(timer)
  })
})
