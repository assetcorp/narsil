import { afterEach, describe, expect, it } from 'vitest'
import { createWorkerOrchestrator, type WorkerOrchestrator } from '../../engine/orchestration'
import { getLanguage } from '../../languages/registry'
import { createNarsil, type Narsil } from '../../narsil'
import { createRebalancer } from '../../partitioning/rebalancer'
import { createPartitionRouter } from '../../partitioning/router'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import { createDirectExecutor } from '../../workers/direct-executor'
import { createExecutionPromoter } from '../../workers/promoter'

const schema = { title: 'string' as const, category: 'string' as const }
const indexConfig: IndexConfig = { schema, language: 'english' }

async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('worker resynchronisation after a rebalance', () => {
  let orchestrator: WorkerOrchestrator | null = null
  let narsil: Narsil | null = null

  afterEach(async () => {
    await orchestrator?.shutdown()
    orchestrator = null
    await narsil?.shutdown()
    narsil = null
  })

  it('serves worker queries from the new partition layout after resync', { timeout: 60_000 }, async () => {
    const executor = createDirectExecutor()
    const english = getLanguage('english')
    executor.createIndex('products', indexConfig, english)
    const manager = executor.getManager('products')
    if (!manager) throw new Error('manager missing')

    for (let i = 0; i < 40; i++) {
      manager.insert(`doc-${i}`, { title: `wireless device ${i}`, category: `cat-${i % 4}` })
    }

    const registry = new Map<
      string,
      { config: IndexConfig; language: LanguageModule; embeddingAdapter: EmbeddingAdapter | null }
    >([['products', { config: indexConfig, language: english, embeddingAdapter: null }]])

    orchestrator = createWorkerOrchestrator(
      { workers: { enabled: true, count: 2 } },
      executor,
      createExecutionPromoter({ perIndexThreshold: 1 }),
      registry,
    )

    await orchestrator.checkPromotion()
    const activeOrchestrator = orchestrator
    await waitFor(() => activeOrchestrator.isPromoted())

    const before = await activeOrchestrator.searchViaWorker('products', { term: 'wireless' })
    expect(before).not.toBeNull()
    expect(before?.totalMatched).toBe(40)

    const rebalancer = createRebalancer()
    await rebalancer.rebalance(manager, 3, createPartitionRouter())
    expect(manager.partitionCount).toBe(3)

    const wasPromoted = activeOrchestrator.desyncIndex('products')
    expect(wasPromoted).toBe(true)
    expect(await activeOrchestrator.searchViaWorker('products', { term: 'wireless' })).toBeNull()

    await activeOrchestrator.resyncIndex('products', wasPromoted)

    const after = await activeOrchestrator.searchViaWorker('products', { term: 'wireless' })
    expect(after).not.toBeNull()
    expect(after?.totalMatched).toBe(40)
  })

  it('promotes an index that was rebalanced before promotion', { timeout: 60_000 }, async () => {
    const partitionSplits: Array<{ oldPartitionCount: number; newPartitionCount: number }> = []
    const workerPromotions: Array<{ workerCount: number }> = []
    narsil = await createNarsil({
      workers: { enabled: true, promotionThreshold: 30 },
      plugins: [
        {
          name: 'lifecycle-recorder',
          onPartitionSplit(ctx) {
            partitionSplits.push({ oldPartitionCount: ctx.oldPartitionCount, newPartitionCount: ctx.newPartitionCount })
          },
          onWorkerPromote(ctx) {
            workerPromotions.push({ workerCount: ctx.workerCount })
          },
        },
      ],
    })
    const engine = narsil
    let promoted = false
    const failures: string[] = []
    engine.on('workerPromote', () => {
      promoted = true
    })
    engine.on('workerPromoteFailure', payload => {
      failures.push(payload.reason)
    })

    await engine.createIndex('products', indexConfig)
    for (let i = 0; i < 20; i++) {
      await engine.insert('products', { id: `early-${i}`, title: `wireless device ${i}`, category: 'early' })
    }

    await engine.rebalance('products', 3)
    expect(engine.getStats('products').partitionCount).toBe(3)

    for (let i = 0; i < 15; i++) {
      await engine.insert('products', { id: `late-${i}`, title: `wireless device late ${i}`, category: 'late' })
    }

    await waitFor(() => promoted || failures.length > 0)
    expect(failures).toEqual([])
    expect(promoted).toBe(true)

    expect(partitionSplits).toEqual([{ oldPartitionCount: 1, newPartitionCount: 3 }])
    await waitFor(() => workerPromotions.length > 0)
    expect(workerPromotions[0].workerCount).toBeGreaterThan(0)

    const result = await engine.query('products', { term: 'wireless' })
    expect(result.count).toBe(35)
  })
})
