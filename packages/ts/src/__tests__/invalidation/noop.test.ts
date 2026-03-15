import { describe, expect, it } from 'vitest'
import { createNoopInvalidation } from '../../invalidation/noop'
import type { InvalidationEvent } from '../../types/adapters'

describe('createNoopInvalidation', () => {
  const sampleEvent: InvalidationEvent = {
    type: 'partition',
    indexName: 'test-index',
    partitions: [0, 1],
    timestamp: Date.now(),
    sourceInstanceId: 'inst-1',
  }

  it('publish resolves without error', async () => {
    const adapter = createNoopInvalidation()
    await expect(adapter.publish(sampleEvent)).resolves.toBeUndefined()
  })

  it('subscribe resolves without error', async () => {
    const adapter = createNoopInvalidation()
    await expect(adapter.subscribe(() => {})).resolves.toBeUndefined()
  })

  it('shutdown resolves without error', async () => {
    const adapter = createNoopInvalidation()
    await expect(adapter.shutdown()).resolves.toBeUndefined()
  })

  it('publish can be called multiple times', async () => {
    const adapter = createNoopInvalidation()
    await adapter.publish(sampleEvent)
    await adapter.publish(sampleEvent)
    await adapter.publish(sampleEvent)
  })

  it('subscribe handler is never called since noop discards events', async () => {
    const adapter = createNoopInvalidation()
    let called = false
    await adapter.subscribe(() => {
      called = true
    })
    await adapter.publish(sampleEvent)
    expect(called).toBe(false)
  })
})
