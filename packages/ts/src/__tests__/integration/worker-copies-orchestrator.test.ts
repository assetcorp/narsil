import { afterEach, describe, expect, it } from 'vitest'
import { createWorkerOrchestrator, type WorkerOrchestrator } from '../../engine/orchestration'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import { createDirectExecutor } from '../../workers/direct-executor'

const schema = {
  title: 'string' as const,
  price: 'number' as const,
}

const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

type Registry = Map<
  string,
  { config: IndexConfig; language: LanguageModule; embeddingAdapter: EmbeddingAdapter | null }
>

describe('WorkerOrchestrator replication and lifecycle', () => {
  let orchestrator: WorkerOrchestrator

  afterEach(async () => {
    await orchestrator?.shutdown()
  })

  it('starts no worker pool while workers are switched off', async () => {
    const executor = createDirectExecutor()
    const registry: Registry = new Map()

    orchestrator = createWorkerOrchestrator({ workers: { enabled: false } }, executor, registry)
    await orchestrator.scaleOutReadyIndexes()

    expect(orchestrator.hasWorkerPool()).toBe(false)
  })

  it('replicateToWorkers is a no-op when no worker pool exists', async () => {
    const executor = createDirectExecutor()
    const registry: Registry = new Map()

    orchestrator = createWorkerOrchestrator({ workers: { enabled: false } }, executor, registry)

    await orchestrator.replicateToWorkers({
      type: 'insert',
      indexName: 'products',
      docId: 'doc1',
      document: { title: 'test' },
      requestId: 'req1',
    })
  })

  it('getWorkerMemoryStats returns empty when no workers are active', async () => {
    const executor = createDirectExecutor()
    const registry: Registry = new Map()

    orchestrator = createWorkerOrchestrator({ workers: { enabled: false } }, executor, registry)

    expect(await orchestrator.getWorkerMemoryStats()).toHaveLength(0)
  })

  it('reports every registered index as scaled in before any copy loads', async () => {
    const executor = createDirectExecutor()
    const registry: Registry = new Map([
      ['products', { config: indexConfig, language: { name: 'english' } as LanguageModule, embeddingAdapter: null }],
    ])

    orchestrator = createWorkerOrchestrator({ workers: { enabled: false } }, executor, registry)

    expect(orchestrator.workerCopies()).toEqual([{ indexName: 'products', scaledOut: false, reloadCount: 0 }])
  })

  it('shutdown is safe to call even without a pool', async () => {
    const executor = createDirectExecutor()
    const registry: Registry = new Map()

    orchestrator = createWorkerOrchestrator({ workers: { enabled: false } }, executor, registry)

    await orchestrator.shutdown()
  })
})

describe('Narsil end-to-end below the copy threshold', () => {
  it('insert and query work while every index stays under the copy threshold', async () => {
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
    expect((await narsil.getMemoryStats()).workers).toEqual([])

    await narsil.shutdown()
  })

  it('mutations continue working correctly when workers are disabled', async () => {
    const { createNarsil } = await import('../../narsil')

    const narsil = await createNarsil({ workers: { enabled: false } })
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

  it('clear replicates without error when no copy is active', async () => {
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
