import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createInvalidationIntegration } from '../../engine/invalidation'
import type { NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { PartitionManager } from '../../partitioning/manager'
import { createFilesystemPersistence } from '../../persistence/filesystem'
import { createMemoryPersistence } from '../../persistence/memory'
import type { InvalidationAdapter, InvalidationEvent } from '../../types/adapters'
import type { NarsilConfig } from '../../types/config'
import type { GlobalStatistics } from '../../types/internal'

interface LocalBus {
  adapterFor(): InvalidationAdapter
  publish(event: InvalidationEvent): Promise<void>
}

function createLocalBus(): LocalBus {
  const handlers = new Set<(event: InvalidationEvent) => void>()

  async function publish(event: InvalidationEvent): Promise<void> {
    for (const handler of handlers) {
      handler(event)
    }
  }

  return {
    publish,
    adapterFor(): InvalidationAdapter {
      let subscribed: ((event: InvalidationEvent) => void) | null = null
      return {
        publish,
        async subscribe(handler) {
          subscribed = handler
          handlers.add(handler)
        },
        async shutdown() {
          if (subscribed !== null) {
            handlers.delete(subscribed)
          }
        },
      }
    },
  }
}

const built = existsSync(new URL('../../../dist/workers/entry.mjs', import.meta.url))
const RELOAD_WAIT_MS = 5_000
const RELOAD_POLL_MS = 20
const WORKERS_HOLDING_EVERY_INDEX = { enabled: true, count: 2, promotionThreshold: 2, mainCopyQueries: 'none' } as const

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + RELOAD_WAIT_MS
  while (!(await check()) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, RELOAD_POLL_MS))
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before timeout')
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('createInvalidationIntegration', () => {
  function makeAggregateStats(totalDocuments: number) {
    return {
      totalDocuments,
      docFrequencies: { widget: totalDocuments },
      totalFieldLengths: { title: totalDocuments * 5 },
    }
  }

  function makeDeps(overrides?: {
    reloadIndex?: (indexName: string) => Promise<void>
    listBroadcastIndexNames?: () => string[]
  }) {
    const bus = createLocalBus()
    const reloads: string[] = []
    const errors: Error[] = []
    const integration = createInvalidationIntegration({
      adapter: bus.adapterFor(),
      instanceId: 'instance-self',
      reloadIndex:
        overrides?.reloadIndex ??
        (async indexName => {
          reloads.push(indexName)
        }),
      getManager: () => ({ getAggregateStats: () => makeAggregateStats(10) }) as unknown as PartitionManager,
      listBroadcastIndexNames: overrides?.listBroadcastIndexNames ?? (() => []),
      onError: error => {
        errors.push(error)
      },
    })
    return { bus, reloads, errors, integration }
  }

  it('reloads the index on a partition event from another instance', async () => {
    const { bus, reloads, integration } = makeDeps()
    await integration.start()

    await bus.publish({
      type: 'partition',
      indexName: 'products',
      partitions: [0],
      timestamp: Date.now(),
      sourceInstanceId: 'instance-other',
    })

    await waitFor(() => reloads.length === 1)
    expect(reloads).toEqual(['products'])
    await integration.shutdown()
  })

  it('ignores its own partition events', async () => {
    const { bus, reloads, integration } = makeDeps()
    await integration.start()

    await bus.publish({
      type: 'partition',
      indexName: 'products',
      partitions: [0],
      timestamp: Date.now(),
      sourceInstanceId: 'instance-self',
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(reloads).toEqual([])
    await integration.shutdown()
  })

  it('merges foreign statistics with the local aggregate for broadcast scoring', async () => {
    const { bus, integration } = makeDeps()
    await integration.start()

    await bus.publish({
      type: 'statistics',
      indexName: 'products',
      instanceId: 'instance-other',
      stats: {
        totalDocs: 30,
        docFrequencies: { widget: 12, gadget: 4 },
        totalFieldLengths: { title: 90 },
      },
    })

    const merged = integration.broadcastStats('products') as GlobalStatistics
    expect(merged.totalDocuments).toBe(40)
    expect(merged.docFrequencies.widget).toBe(22)
    expect(merged.docFrequencies.gadget).toBe(4)
    expect(merged.totalFieldLengths.title).toBe(140)
    expect(merged.averageFieldLengths.title).toBeCloseTo(140 / 40)
    await integration.shutdown()
  })

  it('ignores statistics published under its own instance id', async () => {
    const { bus, integration } = makeDeps()
    await integration.start()

    await bus.publish({
      type: 'statistics',
      indexName: 'products',
      instanceId: 'instance-self',
      stats: { totalDocs: 500, docFrequencies: {}, totalFieldLengths: {} },
    })

    const merged = integration.broadcastStats('products') as GlobalStatistics
    expect(merged.totalDocuments).toBe(10)
    await integration.shutdown()
  })

  it('publishes partition events carrying its own instance id', async () => {
    const { bus, integration } = makeDeps()
    const received: InvalidationEvent[] = []
    const listener = bus.adapterFor()
    await listener.subscribe(event => {
      received.push(event)
    })

    await integration.publishPartitions('products', [0, 1])
    expect(received).toHaveLength(1)
    const event = received[0]
    if (event.type !== 'partition') {
      throw new Error('expected a partition event')
    }
    expect(event.sourceInstanceId).toBe('instance-self')
    expect(event.partitions).toEqual([0, 1])
    await integration.shutdown()
  })

  it('publishes nothing for an empty partition list', async () => {
    const { bus, integration } = makeDeps()
    const received: InvalidationEvent[] = []
    const listener = bus.adapterFor()
    await listener.subscribe(event => {
      received.push(event)
    })

    await integration.publishPartitions('products', [])
    expect(received).toHaveLength(0)
    await integration.shutdown()
  })

  it('routes reload failures to onError instead of throwing', async () => {
    const { bus, errors, integration } = makeDeps({
      reloadIndex: async () => {
        throw new Error('adapter unavailable')
      },
    })
    await integration.start()

    await bus.publish({
      type: 'partition',
      indexName: 'products',
      partitions: [0],
      timestamp: Date.now(),
      sourceInstanceId: 'instance-other',
    })

    await waitFor(() => errors.length === 1)
    expect(errors[0].message).toBe('adapter unavailable')
    await integration.shutdown()
  })
})

describe('invalidation across engine instances', () => {
  let engineA: Narsil | undefined
  let engineB: Narsil | undefined
  const directories: string[] = []

  afterEach(async () => {
    await engineA?.shutdown()
    await engineB?.shutdown()
    engineA = undefined
    engineB = undefined
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  })

  it('rejects invalidation without a shared persistence adapter', async () => {
    const bus = createLocalBus()
    const err = await createNarsil({ invalidation: bus.adapterFor() }).catch(e => e as NarsilError)
    expect((err as NarsilError).code).toBe('CONFIG_INVALID')
  })

  it('rejects invalidation on the write-ahead log tier', async () => {
    const bus = createLocalBus()
    const err = await createNarsil({
      persistence: createMemoryPersistence(),
      durability: { directory: '/tmp/narsil-invalidation-wal-reject' },
      invalidation: bus.adapterFor(),
    }).catch(e => e as NarsilError)
    expect((err as NarsilError).code).toBe('CONFIG_INVALID')
  })

  it('evicts and reloads a foreign mutation after the publisher checkpoints', async () => {
    const shared = createMemoryPersistence()
    const bus = createLocalBus()

    engineA = await createNarsil({ persistence: shared, invalidation: bus.adapterFor() })
    engineB = await createNarsil({ persistence: shared, invalidation: bus.adapterFor() })

    await engineA.createIndex('products', { schema: { title: 'string' } })
    await engineB.createIndex('products', { schema: { title: 'string' } })

    await engineA.insert('products', { title: 'Shared Wireless Mouse' }, 'doc-shared')
    await engineA.checkpoint('products')

    const activeEngineB = engineB
    let found = false
    const deadline = Date.now() + 2000
    while (!found && Date.now() < deadline) {
      found = await activeEngineB.has('products', 'doc-shared')
      if (!found) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    expect(found).toBe(true)

    const result = await activeEngineB.query('products', { term: 'wireless' })
    expect(result.hits.map(hit => hit.id)).toContain('doc-shared')
  })

  it.skipIf(!built).each([
    {
      backend: 'memory',
      sharedConfig: async (): Promise<NarsilConfig> => ({ persistence: createMemoryPersistence() }),
    },
    {
      backend: 'filesystem',
      sharedConfig: async (): Promise<NarsilConfig> => {
        const directory = await mkdtemp(join(tmpdir(), 'narsil-invalidation-removal-'))
        directories.push(directory)
        return { persistence: createFilesystemPersistence({ directory }), durability: { tier: 'snapshot' } }
      },
    },
  ])(
    'drops a document from every other instance and its worker copies once the instance that removed it checkpoints, on $backend persistence',
    async ({ sharedConfig }) => {
      const shared = await sharedConfig()
      const bus = createLocalBus()

      const first = await createNarsil({
        ...shared,
        invalidation: bus.adapterFor(),
        workers: WORKERS_HOLDING_EVERY_INDEX,
      })
      engineA = first
      await first.createIndex('products', { schema: { title: 'string', shape: 'vector[3]' } })
      await first.insertBatch('products', [
        { id: 'doc-kept', title: 'Wired Keyboard', shape: [0, 1, 0] },
        { id: 'doc-moved', title: 'Wireless Mouse', shape: [1, 0, 0] },
      ])
      await first.checkpoint('products')

      const second = await createNarsil({ ...shared, invalidation: bus.adapterFor() })
      engineB = second
      expect(await second.has('products', 'doc-moved')).toBe(true)

      await first.insert('products', { title: 'Wireless Headset', shape: [0, 0, 1] }, 'doc-added')
      await first.checkpoint('products')
      await eventually(() => second.has('products', 'doc-added'))
      expect(await second.has('products', 'doc-added')).toBe(true)
      await eventually(async () => (await first.getMemoryStats()).workerCopies.some(copy => copy.scaledOut))
      expect((await first.getMemoryStats()).workerCopies.some(copy => copy.scaledOut)).toBe(true)

      await second.remove('products', 'doc-moved')
      await second.checkpoint('products')
      await eventually(async () => !(await first.has('products', 'doc-moved')))

      expect(await first.has('products', 'doc-moved')).toBe(false)
      await first.waitForWrites('products')
      expect(await first.countDocuments('products')).toBe(2)
      const result = await first.query('products', { term: 'wireless' })
      expect(result.hits.map(hit => hit.id).sort()).toEqual(['doc-added'])
      const nearest = await first.query('products', {
        mode: 'vector',
        vector: { field: 'shape', value: [1, 0, 0] },
        limit: 3,
      })
      expect(nearest.hits.map(hit => hit.id).sort()).toEqual(['doc-added', 'doc-kept'])
    },
  )
})
