import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFlushManager } from '../../persistence/flush-manager'
import type { InvalidationAdapter, InvalidationEvent, PersistenceAdapter } from '../../types/adapters'

function createMockPersistence(overrides?: Partial<PersistenceAdapter>): PersistenceAdapter {
  return {
    save: vi.fn<PersistenceAdapter['save']>().mockResolvedValue(undefined),
    load: vi.fn<PersistenceAdapter['load']>().mockResolvedValue(null),
    delete: vi.fn<PersistenceAdapter['delete']>().mockResolvedValue(undefined),
    list: vi.fn<PersistenceAdapter['list']>().mockResolvedValue([]),
    ...overrides,
  }
}

function createMockInvalidation(): InvalidationAdapter & { events: InvalidationEvent[] } {
  const events: InvalidationEvent[] = []
  return {
    events,
    publish: vi.fn<InvalidationAdapter['publish']>(async event => {
      events.push(event)
    }),
    subscribe: vi.fn<InvalidationAdapter['subscribe']>().mockResolvedValue(undefined),
    shutdown: vi.fn<InvalidationAdapter['shutdown']>().mockResolvedValue(undefined),
  }
}

function createPartitionDataProvider(): (indexName: string, partitionId: number) => Uint8Array {
  return vi.fn((_indexName: string, partitionId: number) => {
    return new Uint8Array([partitionId])
  })
}

describe('createFlushManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes dirty partitions on explicit flush call', async () => {
    const persistence = createMockPersistence()
    const invalidation = createMockInvalidation()
    const getData = createPartitionDataProvider()

    const manager = createFlushManager({ persistence, invalidation }, getData, () => 'instance-1')

    manager.markDirty('products', 0)
    manager.markDirty('products', 1)
    await manager.flush()

    expect(persistence.save).toHaveBeenCalledTimes(2)
    expect(persistence.save).toHaveBeenCalledWith('products/0', new Uint8Array([0]))
    expect(persistence.save).toHaveBeenCalledWith('products/1', new Uint8Array([1]))

    expect(invalidation.events).toHaveLength(1)
    expect(invalidation.events[0]).toMatchObject({
      type: 'partition',
      indexName: 'products',
      partitions: [0, 1],
      sourceInstanceId: 'instance-1',
    })
  })

  it('fires timer-based flush after the configured interval', async () => {
    const persistence = createMockPersistence()
    const invalidation = createMockInvalidation()
    const getData = createPartitionDataProvider()

    const manager = createFlushManager({ persistence, invalidation, interval: 2000 }, getData, () => 'instance-1')

    manager.markDirty('catalog', 0)

    expect(persistence.save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)

    expect(persistence.save).toHaveBeenCalledWith('catalog/0', new Uint8Array([0]))
    await manager.shutdown()
  })

  it('triggers immediate flush when mutation threshold is reached', async () => {
    const persistence = createMockPersistence()
    const invalidation = createMockInvalidation()
    const getData = createPartitionDataProvider()

    const manager = createFlushManager({ persistence, invalidation, mutationThreshold: 3 }, getData, () => 'instance-1')

    manager.markDirty('idx', 0)
    manager.markDirty('idx', 1)

    expect(persistence.save).not.toHaveBeenCalled()

    manager.markDirty('idx', 2)

    await vi.advanceTimersByTimeAsync(0)

    expect(persistence.save).toHaveBeenCalledTimes(3)
    await manager.shutdown()
  })

  it('retries persistence failures and succeeds after transient errors', async () => {
    vi.useRealTimers()
    let callCount = 0
    const persistence = createMockPersistence({
      save: vi.fn(async () => {
        callCount++
        if (callCount <= 2) {
          throw new Error('Transient network error')
        }
      }),
    })
    const invalidation = createMockInvalidation()
    const getData = createPartitionDataProvider()

    const manager = createFlushManager({ persistence, invalidation, baseRetryDelay: 1 }, getData, () => 'instance-1')

    manager.markDirty('orders', 0)
    await manager.flush()

    expect(persistence.save).toHaveBeenCalledTimes(3)
    expect(invalidation.events).toHaveLength(1)
    await manager.shutdown()
  })

  it('calls onError and re-adds to dirty set when all retries are exhausted', async () => {
    vi.useRealTimers()
    const persistence = createMockPersistence({
      save: vi.fn().mockRejectedValue(new Error('Permanent failure')),
    })
    const invalidation = createMockInvalidation()
    const getData = createPartitionDataProvider()
    const onError = vi.fn()

    const manager = createFlushManager(
      { persistence, invalidation, maxRetries: 2, baseRetryDelay: 1, onError },
      getData,
      () => 'instance-1',
    )

    manager.markDirty('logs', 5)
    await manager.flush()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('logs', 5, expect.any(Error), true)
    expect(invalidation.events).toHaveLength(0)

    ;(persistence.save as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    await manager.flush()

    expect(persistence.save).toHaveBeenCalledWith('logs/5', new Uint8Array([5]))
    await manager.shutdown()
  })

  it('tracks new dirty partitions marked during an active flush', async () => {
    let flushCallCount = 0
    const persistence = createMockPersistence({
      save: vi.fn(async () => {
        flushCallCount++
      }),
    })
    const invalidation = createMockInvalidation()
    const getData = createPartitionDataProvider()

    const manager = createFlushManager({ persistence, invalidation }, getData, () => 'instance-1')

    manager.markDirty('idx', 0)

    const firstFlush = manager.flush()
    manager.markDirty('idx', 1)
    await firstFlush

    expect(flushCallCount).toBe(1)

    await manager.flush()

    expect(flushCallCount).toBe(2)
  })

  it('performs a final flush on shutdown', async () => {
    const persistence = createMockPersistence()
    const invalidation = createMockInvalidation()
    const getData = createPartitionDataProvider()

    const manager = createFlushManager({ persistence, invalidation }, getData, () => 'instance-1')

    manager.markDirty('archive', 0)
    manager.markDirty('archive', 3)

    await manager.shutdown()

    expect(persistence.save).toHaveBeenCalledTimes(2)
    expect(invalidation.events).toHaveLength(1)
  })

  it('publishes invalidation only after successful persistence save', async () => {
    const callOrder: string[] = []
    const persistence = createMockPersistence({
      save: vi.fn(async () => {
        callOrder.push('save')
      }),
    })
    const invalidation = createMockInvalidation()
    const originalPublish = invalidation.publish
    invalidation.publish = vi.fn(async (event: InvalidationEvent) => {
      callOrder.push('publish')
      await originalPublish(event)
    })
    const getData = createPartitionDataProvider()

    const manager = createFlushManager({ persistence, invalidation }, getData, () => 'instance-1')

    manager.markDirty('products', 0)
    await manager.flush()

    expect(callOrder).toEqual(['save', 'publish'])
  })

  it('coalesces concurrent flush calls into a single operation', async () => {
    let saveCount = 0
    const persistence = createMockPersistence({
      save: vi.fn(async () => {
        saveCount++
      }),
    })
    const invalidation = createMockInvalidation()
    const getData = createPartitionDataProvider()

    const manager = createFlushManager({ persistence, invalidation }, getData, () => 'instance-1')

    manager.markDirty('idx', 0)

    const flush1 = manager.flush()
    const flush2 = manager.flush()
    const flush3 = manager.flush()

    await Promise.all([flush1, flush2, flush3])

    expect(saveCount).toBe(1)
  })

  it('flushes partitions across multiple indexes', async () => {
    const persistence = createMockPersistence()
    const invalidation = createMockInvalidation()
    const getData = createPartitionDataProvider()

    const manager = createFlushManager({ persistence, invalidation }, getData, () => 'instance-1')

    manager.markDirty('products', 0)
    manager.markDirty('users', 0)
    manager.markDirty('products', 1)

    await manager.flush()

    expect(persistence.save).toHaveBeenCalledTimes(3)
    expect(invalidation.events).toHaveLength(2)

    const productEvent = invalidation.events.find(e => e.type === 'partition' && e.indexName === 'products')
    const userEvent = invalidation.events.find(e => e.type === 'partition' && e.indexName === 'users')
    expect(productEvent).toBeDefined()
    expect(userEvent).toBeDefined()
    if (productEvent?.type === 'partition') {
      expect(productEvent.partitions).toEqual(expect.arrayContaining([0, 1]))
    }
  })

  it('does not start a new timer after shutdown', async () => {
    const persistence = createMockPersistence()
    const invalidation = createMockInvalidation()
    const getData = createPartitionDataProvider()

    const manager = createFlushManager({ persistence, invalidation, interval: 1000 }, getData, () => 'instance-1')

    manager.markDirty('idx', 0)
    await manager.shutdown()

    vi.spyOn(persistence, 'save').mockClear()
    manager.markDirty('idx', 1)

    await vi.advanceTimersByTimeAsync(5000)

    expect(persistence.save).not.toHaveBeenCalled()
  })

  it('deduplicates the same partition id marked dirty multiple times', async () => {
    const persistence = createMockPersistence()
    const invalidation = createMockInvalidation()
    const getData = createPartitionDataProvider()

    const manager = createFlushManager({ persistence, invalidation }, getData, () => 'instance-1')

    manager.markDirty('idx', 0)
    manager.markDirty('idx', 0)
    manager.markDirty('idx', 0)

    await manager.flush()

    expect(persistence.save).toHaveBeenCalledTimes(1)
  })
})
