import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createPartitionManager } from '../../partitioning/manager'
import { createRebalancer, type RebalanceProgress } from '../../partitioning/rebalancer'
import { createPartitionRouter } from '../../partitioning/router'
import type { LanguageModule } from '../../types/language'
import type { SchemaDefinition } from '../../types/schema'

const english: LanguageModule = {
  name: 'english',
  stemmer: null,
  stopWords: new Set(['the', 'a', 'an', 'is', 'are', 'was', 'in', 'of', 'and', 'to']),
}

const schema: SchemaDefinition = {
  title: 'string' as const,
  score: 'number' as const,
}

function makeDocs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${i}`,
    title: `Document number ${i}`,
    score: i * 10,
  }))
}

function insertDocs(
  manager: ReturnType<typeof createPartitionManager>,
  docs: Array<{ id: string; title: string; score: number }>,
) {
  for (const doc of docs) {
    manager.insert(doc.id, { title: doc.title, score: doc.score })
  }
}

describe('Rebalancer', () => {
  it('rebalances from 2 to 4 partitions preserving all documents', async () => {
    const router = createPartitionRouter()
    const manager = createPartitionManager('test-index', { schema }, english, router, 2)
    const docs = makeDocs(100)
    insertDocs(manager, docs)

    expect(manager.countDocuments()).toBe(100)

    const rebalancer = createRebalancer()
    await rebalancer.rebalance(manager, 4, router)

    expect(manager.partitionCount).toBe(4)
    expect(manager.countDocuments()).toBe(100)

    for (const doc of docs) {
      const retrieved = manager.get(doc.id)
      expect(retrieved).toBeDefined()
      expect(retrieved?.title).toBe(doc.title)
      expect(retrieved?.score).toBe(doc.score)
    }
  })

  it('rebalances from 4 to 2 partitions preserving all documents', async () => {
    const router = createPartitionRouter()
    const manager = createPartitionManager('test-index', { schema }, english, router, 4)
    const docs = makeDocs(100)
    insertDocs(manager, docs)

    expect(manager.countDocuments()).toBe(100)

    const rebalancer = createRebalancer()
    await rebalancer.rebalance(manager, 2, router)

    expect(manager.partitionCount).toBe(2)
    expect(manager.countDocuments()).toBe(100)

    for (const doc of docs) {
      const retrieved = manager.get(doc.id)
      expect(retrieved).toBeDefined()
      expect(retrieved?.title).toBe(doc.title)
      expect(retrieved?.score).toBe(doc.score)
    }
  })

  it('handles rebalance with 0 documents without errors', async () => {
    const router = createPartitionRouter()
    const manager = createPartitionManager('test-index', { schema }, english, router, 2)

    expect(manager.countDocuments()).toBe(0)

    const rebalancer = createRebalancer()
    await rebalancer.rebalance(manager, 4, router)

    expect(manager.partitionCount).toBe(4)
    expect(manager.countDocuments()).toBe(0)
  })

  it('throws PARTITION_REBALANCING_BACKPRESSURE on concurrent rebalance', async () => {
    const router = createPartitionRouter()
    const manager = createPartitionManager('test-index', { schema }, english, router, 2)
    const docs = makeDocs(50)
    insertDocs(manager, docs)

    const rebalancer = createRebalancer()
    const firstRebalance = rebalancer.rebalance(manager, 4, router)

    expect(rebalancer.isRebalancing()).toBe(true)

    try {
      await rebalancer.rebalance(manager, 4, router)
      expect.fail('Expected a NarsilError to be thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(NarsilError)
      expect((error as NarsilError).code).toBe(ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE)
    }

    await firstRebalance
    expect(rebalancer.isRebalancing()).toBe(false)
  })

  it('fires progress callback with increasing progress values', async () => {
    const router = createPartitionRouter()
    const manager = createPartitionManager('test-index', { schema }, english, router, 2)
    const docs = makeDocs(50)
    insertDocs(manager, docs)

    const progressEvents: RebalanceProgress[] = []
    const rebalancer = createRebalancer()
    await rebalancer.rebalance(manager, 4, router, progress => {
      progressEvents.push({ ...progress })
    })

    expect(progressEvents.length).toBeGreaterThanOrEqual(3)

    const phases = progressEvents.map(p => p.phase)
    expect(phases[0]).toBe('scanning')
    expect(phases).toContain('moving')
    expect(phases[phases.length - 1]).toBe('complete')

    for (const event of progressEvents) {
      expect(event.documentsTotal).toBe(50)
    }

    const movingEvents = progressEvents.filter(p => p.phase === 'moving')
    for (let i = 1; i < movingEvents.length; i++) {
      expect(movingEvents[i].documentsProcessed).toBeGreaterThanOrEqual(movingEvents[i - 1].documentsProcessed)
    }
  })

  it('preserves document content integrity after rebalance', async () => {
    const router = createPartitionRouter()
    const manager = createPartitionManager('test-index', { schema }, english, router, 2)

    const testDocs = [
      { id: 'alpha', title: 'Search engines and information retrieval', score: 95 },
      { id: 'beta', title: 'Distributed systems design patterns', score: 87 },
      { id: 'gamma', title: 'Full-text indexing with inverted indexes', score: 73 },
      { id: 'delta', title: 'Vector similarity and nearest neighbors', score: 61 },
    ]
    for (const doc of testDocs) {
      manager.insert(doc.id, { title: doc.title, score: doc.score })
    }

    const rebalancer = createRebalancer()
    await rebalancer.rebalance(manager, 3, router)

    for (const doc of testDocs) {
      const retrieved = manager.get(doc.id)
      expect(retrieved).toBeDefined()
      expect(retrieved?.title).toBe(doc.title)
      expect(retrieved?.score).toBe(doc.score)
    }
  })

  it('throws when newPartitionCount is 0', async () => {
    const router = createPartitionRouter()
    const manager = createPartitionManager('test-index', { schema }, english, router, 2)

    const rebalancer = createRebalancer()

    try {
      await rebalancer.rebalance(manager, 0, router)
      expect.fail('Expected a NarsilError to be thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(NarsilError)
      expect((error as NarsilError).code).toBe(ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE)
    }
  })

  it('throws when newPartitionCount equals current partition count', async () => {
    const router = createPartitionRouter()
    const manager = createPartitionManager('test-index', { schema }, english, router, 3)

    const rebalancer = createRebalancer()

    try {
      await rebalancer.rebalance(manager, 3, router)
      expect.fail('Expected a NarsilError to be thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(NarsilError)
      expect((error as NarsilError).code).toBe(ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE)
    }
  })

  it('resets rebalancing flag even when an error occurs', async () => {
    const router = createPartitionRouter()
    const manager = createPartitionManager('test-index', { schema }, english, router, 2)

    const rebalancer = createRebalancer()

    try {
      await rebalancer.rebalance(manager, 0, router)
    } catch {
      /* expected */
    }

    expect(rebalancer.isRebalancing()).toBe(false)
  })

  it('handles large document sets across chunk boundaries', async () => {
    const router = createPartitionRouter()
    const manager = createPartitionManager('test-index', { schema }, english, router, 1)
    const docs = makeDocs(2500)
    insertDocs(manager, docs)

    const rebalancer = createRebalancer()
    const progressEvents: RebalanceProgress[] = []
    await rebalancer.rebalance(manager, 4, router, progress => {
      progressEvents.push({ ...progress })
    })

    expect(manager.partitionCount).toBe(4)
    expect(manager.countDocuments()).toBe(2500)

    const movingEvents = progressEvents.filter(p => p.phase === 'moving')
    expect(movingEvents.length).toBeGreaterThanOrEqual(3)

    for (const doc of docs) {
      expect(manager.has(doc.id)).toBe(true)
    }
  })
})
