import { afterEach, describe, expect, it } from 'vitest'
import { createWorkerOrchestrator, type WorkerOrchestrator } from '../../engine/orchestration'
import { getLanguage } from '../../languages/registry'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import { createDirectExecutor } from '../../workers/direct-executor'
import { createExecutionPromoter, type ExecutionPromoter } from '../../workers/promoter'

const schema = {
  title: 'string' as const,
  price: 'number' as const,
}

const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

describe('ExecutionPromoter threshold detection', () => {
  let promoter: ExecutionPromoter

  it('signals promotion when a single index exceeds the per-index threshold', () => {
    promoter = createExecutionPromoter({ perIndexThreshold: 100 })

    const indexes = new Map([['products', { documentCount: 150 }]])
    const result = promoter.check(indexes)

    expect(result.shouldPromote).toBe(true)
    expect(result.reason).toContain('products')
    expect(result.reason).toContain('150')
  })

  it('signals promotion when total documents exceed the total threshold', () => {
    promoter = createExecutionPromoter({ perIndexThreshold: 1000, totalThreshold: 200 })

    const indexes = new Map([
      ['products', { documentCount: 80 }],
      ['users', { documentCount: 80 }],
      ['orders', { documentCount: 80 }],
    ])
    const result = promoter.check(indexes)

    expect(result.shouldPromote).toBe(true)
    expect(result.reason).toContain('240')
  })

  it('does not signal promotion below both thresholds', () => {
    promoter = createExecutionPromoter({ perIndexThreshold: 1000, totalThreshold: 500 })

    const indexes = new Map([
      ['products', { documentCount: 50 }],
      ['users', { documentCount: 30 }],
    ])
    const result = promoter.check(indexes)

    expect(result.shouldPromote).toBe(false)
  })

  it('returns shouldPromote=false after markPromoted is called', () => {
    promoter = createExecutionPromoter({ perIndexThreshold: 10 })

    const indexes = new Map([['products', { documentCount: 50 }]])
    const first = promoter.check(indexes)
    expect(first.shouldPromote).toBe(true)

    promoter.markPromoted()

    const second = promoter.check(indexes)
    expect(second.shouldPromote).toBe(false)
  })

  it('is a one-way transition: isPromoted stays true', () => {
    promoter = createExecutionPromoter()
    expect(promoter.isPromoted()).toBe(false)

    promoter.markPromoted()
    expect(promoter.isPromoted()).toBe(true)
  })
})

describe('WorkerOrchestrator replication and lifecycle', () => {
  let orchestrator: WorkerOrchestrator

  afterEach(async () => {
    await orchestrator?.shutdown()
  })

  it('checkPromotion is a no-op when workers are disabled', () => {
    const executor = createDirectExecutor()
    const promoter = createExecutionPromoter({ perIndexThreshold: 1 })
    const registry = new Map<string, { config: IndexConfig; language: LanguageModule }>()

    orchestrator = createWorkerOrchestrator(undefined, executor, promoter, registry)
    orchestrator.checkPromotion()

    expect(promoter.isPromoted()).toBe(false)
  })

  it('replicateToWorkers is a no-op when no worker pool exists', async () => {
    const executor = createDirectExecutor()
    const promoter = createExecutionPromoter()
    const registry = new Map<string, { config: IndexConfig; language: LanguageModule }>()

    orchestrator = createWorkerOrchestrator(undefined, executor, promoter, registry)

    await orchestrator.replicateToWorkers({
      type: 'insert',
      indexName: 'products',
      docId: 'doc1',
      document: { title: 'test' },
      requestId: 'req1',
    })
  })

  it('getMemoryStats returns empty when no workers are active', () => {
    const executor = createDirectExecutor()
    const promoter = createExecutionPromoter()
    const registry = new Map<string, { config: IndexConfig; language: LanguageModule }>()

    orchestrator = createWorkerOrchestrator(undefined, executor, promoter, registry)

    const stats = orchestrator.getMemoryStats()
    expect(stats.totalBytes).toBe(0)
    expect(stats.workers).toHaveLength(0)
  })

  it('shutdown is safe to call even without promotion', async () => {
    const executor = createDirectExecutor()
    const promoter = createExecutionPromoter()
    const registry = new Map<string, { config: IndexConfig; language: LanguageModule }>()

    orchestrator = createWorkerOrchestrator(undefined, executor, promoter, registry)

    await orchestrator.shutdown()
  })
})

describe('Narsil end-to-end with promotion check wiring', () => {
  it('insert and query work correctly even when promotion is configured but not triggered', async () => {
    const { createNarsil } = await import('../../narsil')

    const narsil = await createNarsil({
      workers: {
        enabled: true,
        promotionThreshold: 100_000,
      },
    })

    await narsil.createIndex('products', indexConfig)

    for (let i = 0; i < 10; i++) {
      await narsil.insert('products', { title: `Product ${i}`, price: i * 10 })
    }

    const result = await narsil.query('products', { term: 'Product' })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.count).toBe(10)

    await narsil.shutdown()
  })

  it('mutations continue working correctly when workers are disabled', async () => {
    const { createNarsil } = await import('../../narsil')

    const narsil = await createNarsil()
    await narsil.createIndex('products', indexConfig)

    const id = await narsil.insert('products', { title: 'Headphones', price: 99 })
    await narsil.update('products', id, { title: 'Premium Headphones', price: 149 })

    const doc = await narsil.get('products', id)
    expect(doc?.title).toBe('Premium Headphones')

    await narsil.remove('products', id)
    const removed = await narsil.get('products', id)
    expect(removed).toBeUndefined()

    await narsil.shutdown()
  })

  it('clear replicates without error when workers are not active', async () => {
    const { createNarsil } = await import('../../narsil')

    const narsil = await createNarsil({
      workers: { enabled: true, promotionThreshold: 100_000 },
    })

    await narsil.createIndex('products', indexConfig)
    await narsil.insert('products', { title: 'Test', price: 10 })
    await narsil.clear('products')

    const count = await narsil.countDocuments('products')
    expect(count).toBe(0)

    await narsil.shutdown()
  })
})
