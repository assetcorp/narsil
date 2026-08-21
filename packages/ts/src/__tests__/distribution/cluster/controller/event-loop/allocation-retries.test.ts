import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putIndexMetadata } from '../../../../../distribution/cluster/controller'
import {
  handleSchemaEvent,
  scheduleDebouncedAllocation,
} from '../../../../../distribution/cluster/controller/event-loop/allocation'
import { createEventLoopState } from '../../../../../distribution/cluster/controller/event-loop/state'
import { createInMemoryCoordinator } from '../../../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../../../distribution/coordinator/types'
import { makeAllocationTable, makeIndexMetadata, makeNode, testSchema } from '../controller/fixtures'

describe('controller allocation retries', () => {
  let coordinator: ClusterCoordinator

  beforeEach(async () => {
    vi.useFakeTimers()
    coordinator = createInMemoryCoordinator()
    await coordinator.registerNode(makeNode('data-1'))
    await putIndexMetadata(coordinator, makeIndexMetadata('products', 1, 0))
    await coordinator.putAllocation('products', makeAllocationTable('products', ['data-1'], 1))
  })

  afterEach(async () => {
    await coordinator.shutdown()
    vi.useRealTimers()
  })

  async function flush(): Promise<void> {
    for (let round = 0; round < 20; round++) {
      await Promise.resolve()
    }
  }

  it('runs the allocator again after every compare-and-set attempt fails', async () => {
    const state = createEventLoopState(['products'])
    coordinator.putAllocation = async () => false
    const reads: string[] = []
    const readAllocation = coordinator.getAllocation.bind(coordinator)
    coordinator.getAllocation = async (indexName: string) => {
      reads.push(indexName)
      return readAllocation(indexName)
    }
    const onError = vi.fn()

    scheduleDebouncedAllocation(state, coordinator, () => true, onError)
    await vi.advanceTimersByTimeAsync(600)
    await flush()
    const readsAfterFirstRun = reads.length

    await vi.advanceTimersByTimeAsync(1_100)
    await flush()

    expect(onError).toHaveBeenCalled()
    expect(reads.length).toBeGreaterThan(readsAfterFirstRun)
  })

  it('reports an error when a dropped index keeps losing its teardown write', async () => {
    const state = createEventLoopState(['products'])
    coordinator.putAllocation = async () => false
    const deleteAllocation = vi.fn()
    coordinator.deleteAllocation = deleteAllocation
    const onError = vi.fn()

    const teardown = handleSchemaEvent(
      { type: 'schema_dropped', indexName: 'products', schema: null },
      coordinator,
      state,
      () => true,
      onError,
    )
    await vi.advanceTimersByTimeAsync(5_000)
    await flush()
    await teardown

    expect(deleteAllocation).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('products', expect.anything())
  })

  it('deletes the allocation of a dropped index once a teardown write lands', async () => {
    const state = createEventLoopState(['products'])
    const deleteAllocation = vi.fn()
    coordinator.deleteAllocation = deleteAllocation
    await coordinator.putSchema('products', testSchema)

    await handleSchemaEvent(
      { type: 'schema_dropped', indexName: 'products', schema: null },
      coordinator,
      state,
      () => true,
    )

    expect(deleteAllocation).toHaveBeenCalledWith('products')
    expect(state.knownIndexes.has('products')).toBe(false)
  })
})
