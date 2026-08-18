import { describe, expect, it } from 'vitest'
import { createPartitionIndex } from '../../../core/partition'
import { isCompositePartition } from '../../../core/partition/composite'
import { createFrozenSegment } from '../../../core/partition/frozen'
import type { SegmentPayload } from '../../../core/partition/segment-payload'
import { awaitCompactions, maybeCompactSegments } from '../../../engine/orchestration/compaction'
import type { OrchestratorState } from '../../../engine/orchestration/types'
import type { AnyDocument, SchemaDefinition } from '../../../types/schema'
import { createDirectExecutor } from '../../../workers/direct-executor'
import { createExecutionPromoter } from '../../../workers/promoter'
import { english } from '../../core/partition-index/fixtures'

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

function stateWith(executor: OrchestratorState['executor']): OrchestratorState {
  return {
    config: undefined,
    executor,
    promoter: createExecutionPromoter(),
    indexRegistry: new Map(),
    callbacks: undefined,
    workersEnabled: false,
    bootstrapModule: undefined,
    promotionBuffer: [],
    awaitingBufferedWrites: new Set(),
    reportedIneligible: new Set(),
    promotedIndexes: new Set(),
    replicationQueues: new Map(),
    segmentLedger: new Map(),
    compactionsInFlight: new Map(),
    workerPool: null,
    promotionInProgress: false,
    promotionBlocked: false,
    promotionRun: null,
  }
}

describe('segment compaction', () => {
  it('folds a partition holding eight frozen segments into one on the main thread', async () => {
    const executor = createDirectExecutor()
    await executor.execute({ type: 'createIndex', indexName: 'products', config: { schema }, requestId: 'create' })
    const manager = executor.getManager('products')
    expect(manager).toBeDefined()
    if (!manager) return

    let total = 0
    for (let s = 0; s < 8; s++) {
      const { payload, documents } = segmentFor(`seg${s}`, 4 + s)
      manager.attachFrozenSegment(0, createFrozenSegment(payload, documents))
      total += documents.length
    }

    const state = stateWith(executor)
    maybeCompactSegments(state, 'products')
    await awaitCompactions(state)

    const partition = manager.getPartition(0)
    expect(isCompositePartition(partition)).toBe(true)
    if (!isCompositePartition(partition)) return
    expect(partition.frozenSegmentCount()).toBe(1)
    expect(partition.count()).toBe(total)
    expect(manager.has('seg0-0')).toBe(true)
    expect(manager.has('seg7-10')).toBe(true)
    expect(manager.get('seg3-2')).toMatchObject({ title: 'seg3 shared entry' })
  })
})
