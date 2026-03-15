import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBroadcastChannelInvalidation } from '../../invalidation/broadcast-channel'
import type { InvalidationEvent } from '../../types/adapters'

type MessageHandler = ((event: MessageEvent) => void) | null

class MockBroadcastChannel {
  name: string
  onmessage: MessageHandler = null
  closed = false

  static instances: MockBroadcastChannel[] = []

  constructor(name: string) {
    this.name = name
    MockBroadcastChannel.instances.push(this)
  }

  postMessage(data: unknown): void {
    if (this.closed) {
      throw new Error('Channel is closed')
    }
    for (const ch of MockBroadcastChannel.instances) {
      if (ch !== this && ch.name === this.name && !ch.closed && ch.onmessage) {
        ch.onmessage(new MessageEvent('message', { data }))
      }
    }
  }

  close(): void {
    this.closed = true
    const index = MockBroadcastChannel.instances.indexOf(this)
    if (index !== -1) {
      MockBroadcastChannel.instances.splice(index, 1)
    }
  }

  static reset(): void {
    MockBroadcastChannel.instances = []
  }
}

function samplePartitionEvent(): InvalidationEvent {
  return {
    type: 'partition',
    indexName: 'products',
    partitions: [0, 1],
    timestamp: Date.now(),
    sourceInstanceId: 'node-1',
  }
}

describe('createBroadcastChannelInvalidation', () => {
  beforeEach(() => {
    MockBroadcastChannel.reset()
    ;(globalThis as Record<string, unknown>).BroadcastChannel = MockBroadcastChannel
  })

  afterEach(() => {
    MockBroadcastChannel.reset()
    delete (globalThis as Record<string, unknown>).BroadcastChannel
  })

  it('publishes and delivers events between two adapters on the same channel', async () => {
    const sender = createBroadcastChannelInvalidation({ channelName: 'test-channel' })
    const receiver = createBroadcastChannelInvalidation({ channelName: 'test-channel' })

    const received: InvalidationEvent[] = []
    await receiver.subscribe(event => {
      received.push(event)
    })

    const event = samplePartitionEvent()
    await sender.publish(event)

    expect(received.length).toBe(1)
    expect(received[0].type).toBe('partition')
    expect(received[0].indexName).toBe('products')

    await sender.shutdown()
    await receiver.shutdown()
  })

  it('uses default channel name when no config is provided', async () => {
    const adapter = createBroadcastChannelInvalidation()

    await adapter.publish(samplePartitionEvent())
    await adapter.shutdown()
  })

  it('discards messages without a valid type field', async () => {
    const adapter = createBroadcastChannelInvalidation({ channelName: 'validation-test' })

    const received: InvalidationEvent[] = []
    await adapter.subscribe(event => {
      received.push(event)
    })

    const receiverInstance = MockBroadcastChannel.instances.find(
      ch => ch.name === 'validation-test' && ch.onmessage !== null,
    )

    expect(receiverInstance).toBeDefined()
    const onmessage = receiverInstance?.onmessage
    expect(onmessage).toBeDefined()

    onmessage?.(new MessageEvent('message', { data: { noType: true } }))
    onmessage?.(new MessageEvent('message', { data: null }))
    onmessage?.(new MessageEvent('message', { data: 'string-data' }))
    onmessage?.(new MessageEvent('message', { data: { type: 'unknown-type' } }))

    expect(received.length).toBe(0)

    await adapter.shutdown()
  })

  it('shutdown closes the channel', async () => {
    const adapter = createBroadcastChannelInvalidation({ channelName: 'close-test' })

    await adapter.publish(samplePartitionEvent())
    await adapter.shutdown()

    const found = MockBroadcastChannel.instances.find(ch => ch.name === 'close-test')
    expect(found).toBeUndefined()
  })

  it('throws a descriptive error when BroadcastChannel is not available', async () => {
    delete (globalThis as Record<string, unknown>).BroadcastChannel

    const adapter = createBroadcastChannelInvalidation()

    await expect(adapter.publish(samplePartitionEvent())).rejects.toThrow('BroadcastChannel is not available')
  })

  it('does not create the channel until first publish or subscribe', () => {
    createBroadcastChannelInvalidation({ channelName: 'lazy-test' })

    const found = MockBroadcastChannel.instances.find(ch => ch.name === 'lazy-test')
    expect(found).toBeUndefined()
  })

  it('handles statistics events correctly', async () => {
    const sender = createBroadcastChannelInvalidation({ channelName: 'stats-test' })
    const receiver = createBroadcastChannelInvalidation({ channelName: 'stats-test' })

    const received: InvalidationEvent[] = []
    await receiver.subscribe(event => {
      received.push(event)
    })

    const statsEvent: InvalidationEvent = {
      type: 'statistics',
      indexName: 'products',
      instanceId: 'node-1',
      stats: {
        totalDocs: 100,
        docFrequencies: { title: 50 },
        totalFieldLengths: { title: 500 },
      },
    }

    await sender.publish(statsEvent)

    expect(received.length).toBe(1)
    expect(received[0].type).toBe('statistics')

    await sender.shutdown()
    await receiver.shutdown()
  })
})
