import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'
import { DIM, normalizedVector } from './fixtures'

vi.mock('../../../vector/hnsw-worker-dispatch', () => ({
  dispatchWorkerBuild: vi.fn().mockResolvedValue({ ok: false, reason: 'no-workers', message: 'mocked' }),
}))

const FIRST_BATCH = 300
const SECOND_BATCH = 300

function levelsByDocId(index: VectorIndex): Map<string, number> {
  const payload = index.serialize()
  const levels = new Map<string, number>()
  const graph = payload.graphs[0]
  if (graph === undefined) return levels
  for (const [docId, level] of graph.nodes) {
    levels.set(docId, level)
  }
  return levels
}

function insertRange(index: VectorIndex, from: number, to: number): void {
  for (let i = from; i < to; i++) {
    index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
  }
}

function nextTick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

async function buildToCompletion(index: VectorIndex): Promise<void> {
  index.scheduleBuild()
  await nextTick()
  await index.awaitPendingBuild()
}

function countPreservedLevels(before: Map<string, number>, after: Map<string, number>): number {
  let preserved = 0
  for (const [docId, level] of before) {
    if (after.get(docId) === level) preserved++
  }
  return preserved
}

describe('VectorIndex graph growth across batches', () => {
  let index: VectorIndex

  beforeEach(() => {
    index = createVectorIndex('embedding', DIM, { threshold: FIRST_BATCH, quantization: 'none' })
  })

  afterEach(() => {
    index.dispose()
  })

  it('adds a later batch to the graph the first batch built', async () => {
    insertRange(index, 0, FIRST_BATCH)
    await buildToCompletion(index)
    const afterFirstBatch = levelsByDocId(index)
    expect(afterFirstBatch.size).toBe(FIRST_BATCH)

    insertRange(index, FIRST_BATCH, FIRST_BATCH + SECOND_BATCH)
    await buildToCompletion(index)
    const afterSecondBatch = levelsByDocId(index)

    expect(afterSecondBatch.size).toBe(FIRST_BATCH + SECOND_BATCH)
    expect(countPreservedLevels(afterFirstBatch, afterSecondBatch)).toBe(FIRST_BATCH)
    expect(index.maintenanceStatus().bufferSize).toBe(0)
  })

  it('builds the vectors that arrive during a build once that build finishes', async () => {
    insertRange(index, 0, FIRST_BATCH)
    index.scheduleBuild()
    await nextTick()
    expect(index.maintenanceStatus().building).toBe(true)

    insertRange(index, FIRST_BATCH, FIRST_BATCH + SECOND_BATCH)
    await index.awaitPendingBuild()
    await nextTick()
    await index.awaitPendingBuild()

    expect(index.maintenanceStatus().bufferSize).toBe(0)
    expect(levelsByDocId(index).size).toBe(FIRST_BATCH + SECOND_BATCH)
  })

  it('optimise adds the vectors the graph is missing and keeps the rest', async () => {
    insertRange(index, 0, FIRST_BATCH)
    await buildToCompletion(index)
    const afterFirstBatch = levelsByDocId(index)

    insertRange(index, FIRST_BATCH, FIRST_BATCH + SECOND_BATCH)
    await index.optimize()

    const afterOptimize = levelsByDocId(index)
    expect(afterOptimize.size).toBe(FIRST_BATCH + SECOND_BATCH)
    expect(countPreservedLevels(afterFirstBatch, afterOptimize)).toBe(FIRST_BATCH)
    expect(index.maintenanceStatus().bufferSize).toBe(0)
  })

  it('optimise keeps the graph when a fifth of the vectors have gone', async () => {
    insertRange(index, 0, FIRST_BATCH)
    await buildToCompletion(index)
    const afterFirstBatch = levelsByDocId(index)

    const removed = FIRST_BATCH / 5
    for (let i = 0; i < removed; i++) {
      index.remove(`doc${i}`)
    }
    await index.optimize()

    const afterOptimize = levelsByDocId(index)
    expect(afterOptimize.size).toBe(FIRST_BATCH - removed)
    expect(countPreservedLevels(afterOptimize, afterFirstBatch)).toBe(FIRST_BATCH - removed)
  })

  it('optimise rebuilds the graph once more than a fifth of the vectors have gone', async () => {
    insertRange(index, 0, FIRST_BATCH)
    await buildToCompletion(index)
    const afterFirstBatch = levelsByDocId(index)

    const removed = FIRST_BATCH / 4
    for (let i = 0; i < removed; i++) {
      index.remove(`doc${i}`)
    }
    await index.optimize()

    const afterOptimize = levelsByDocId(index)
    expect(afterOptimize.size).toBe(FIRST_BATCH - removed)
    expect(countPreservedLevels(afterOptimize, afterFirstBatch)).toBeLessThan(FIRST_BATCH - removed)
  })

  it('optimise rebuilds the graph after compact removed more than a fifth', async () => {
    insertRange(index, 0, FIRST_BATCH)
    await buildToCompletion(index)
    const afterFirstBatch = levelsByDocId(index)

    const removed = FIRST_BATCH / 4
    for (let i = 0; i < removed; i++) {
      index.remove(`doc${i}`)
    }
    index.compact()
    expect(index.maintenanceStatus().tombstoneRatio).toBe(0)

    await index.optimize()

    const afterOptimize = levelsByDocId(index)
    expect(afterOptimize.size).toBe(FIRST_BATCH - removed)
    expect(countPreservedLevels(afterOptimize, afterFirstBatch)).toBeLessThan(FIRST_BATCH - removed)
  })

  it('counts a vector removed, put back, and removed again', async () => {
    insertRange(index, 0, FIRST_BATCH)
    await buildToCompletion(index)
    const afterFirstBatch = levelsByDocId(index)

    const churned = FIRST_BATCH / 3
    for (let i = 0; i < churned; i++) {
      index.remove(`doc${i}`)
      index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
      index.remove(`doc${i}`)
    }
    await index.optimize()

    const afterOptimize = levelsByDocId(index)
    expect(afterOptimize.size).toBe(FIRST_BATCH - churned)
    expect(countPreservedLevels(afterOptimize, afterFirstBatch)).toBeLessThan(FIRST_BATCH - churned)
  })

  it('measures removals against the vectors the graph holds after every vector was replaced', async () => {
    insertRange(index, 0, FIRST_BATCH)
    await buildToCompletion(index)

    for (let i = 0; i < FIRST_BATCH; i++) {
      index.insert(`doc${i}`, normalizedVector(DIM, i + FIRST_BATCH + 1))
    }
    await buildToCompletion(index)
    const afterReplacement = levelsByDocId(index)
    expect(afterReplacement.size).toBe(FIRST_BATCH)

    const removed = FIRST_BATCH / 4
    for (let i = 0; i < removed; i++) {
      index.remove(`doc${i}`)
    }
    await index.optimize()

    const afterOptimize = levelsByDocId(index)
    expect(afterOptimize.size).toBe(FIRST_BATCH - removed)
    expect(countPreservedLevels(afterOptimize, afterReplacement)).toBeLessThan(FIRST_BATCH - removed)
  })

  it('optimise relinks a vector that was replaced after the graph held it', async () => {
    insertRange(index, 0, FIRST_BATCH)
    await buildToCompletion(index)

    const replacement = normalizedVector(DIM, FIRST_BATCH * 7 + 1)
    index.insert('doc0', replacement)
    await index.optimize()
    expect(index.maintenanceStatus().bufferSize).toBe(0)

    const hits = index.search(replacement, 1, { metric: 'cosine', minSimilarity: 0 })
    expect(hits[0]?.docId).toBe('doc0')
  })

  it('keeps a vector inserted while optimise is running visible to search', async () => {
    insertRange(index, 0, FIRST_BATCH)
    await buildToCompletion(index)
    insertRange(index, FIRST_BATCH, FIRST_BATCH + SECOND_BATCH)

    const optimizing = index.optimize()
    await nextTick()
    const lateVector = normalizedVector(DIM, FIRST_BATCH * 11 + 1)
    index.insert('late', lateVector)
    await optimizing

    expect(index.has('late')).toBe(true)
    const hits = index.search(lateVector, 1, { metric: 'cosine', minSimilarity: 0 })
    expect(hits[0]?.docId).toBe('late')
  })

  it('counts removals again from the graph the rebuild produced', async () => {
    insertRange(index, 0, FIRST_BATCH)
    await buildToCompletion(index)

    for (let i = 0; i < FIRST_BATCH / 4; i++) {
      index.remove(`doc${i}`)
    }
    await index.optimize()
    const afterRebuild = levelsByDocId(index)

    index.remove(`doc${FIRST_BATCH - 1}`)
    await index.optimize()

    const afterSecondOptimize = levelsByDocId(index)
    expect(afterSecondOptimize.size).toBe(afterRebuild.size - 1)
    expect(countPreservedLevels(afterSecondOptimize, afterRebuild)).toBe(afterRebuild.size - 1)
  })
})
