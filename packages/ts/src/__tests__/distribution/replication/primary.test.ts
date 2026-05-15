import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { createAckMessage } from '../../../distribution/replication/codec'
import { replicateToReplicas } from '../../../distribution/replication/primary'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport/in-memory'
import type { TransportMessage } from '../../../distribution/transport/types'
import { ReplicationMessageTypes } from '../../../distribution/transport/types'

function makeEntry(overrides?: Partial<ReplicationLogEntry>): ReplicationLogEntry {
  return {
    seqNo: 1,
    primaryTerm: 1,
    operation: 'INDEX',
    partitionId: 0,
    indexName: 'products',
    documentId: 'doc-001',
    document: encode({ title: 'Wireless Headphones', price: 149 }),
    checksum: 12345,
    ...overrides,
  }
}

describe('replicateToReplicas', () => {
  it('returns empty result when no replicas are provided', async () => {
    const network = createInMemoryNetwork()
    const transport = createInMemoryTransport('primary', network)
    const result = await replicateToReplicas(makeEntry(), [], transport, 'primary')

    expect(result.acknowledged).toEqual([])
    expect(result.failed).toEqual([])
    await transport.shutdown()
  })

  it('acknowledges a single replica that responds with ack', async () => {
    const network = createInMemoryNetwork()
    const primaryTransport = createInMemoryTransport('primary', network)
    const replicaTransport = createInMemoryTransport('replica-a', network)

    await replicaTransport.listen((message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.ENTRY) {
        respond(createAckMessage(1, 0, 'products', 'replica-a', message.requestId))
      }
    })

    const result = await replicateToReplicas(makeEntry(), ['replica-a'], primaryTransport, 'primary')

    expect(result.acknowledged).toEqual(['replica-a'])
    expect(result.failed).toEqual([])

    await primaryTransport.shutdown()
    await replicaTransport.shutdown()
  })

  it('acknowledges multiple replicas that all respond with ack', async () => {
    const network = createInMemoryNetwork()
    const primaryTransport = createInMemoryTransport('primary', network)
    const replicaA = createInMemoryTransport('replica-a', network)
    const replicaB = createInMemoryTransport('replica-b', network)

    const ackHandler = (message: TransportMessage, respond: (r: TransportMessage) => void, nodeId: string) => {
      if (message.type === ReplicationMessageTypes.ENTRY) {
        respond(createAckMessage(1, 0, 'products', nodeId, message.requestId))
      }
    }

    await replicaA.listen((msg, respond) => ackHandler(msg, respond, 'replica-a'))
    await replicaB.listen((msg, respond) => ackHandler(msg, respond, 'replica-b'))

    const result = await replicateToReplicas(
      makeEntry(),
      ['replica-a', 'replica-b'],
      primaryTransport,
      'primary',
      10_000,
    )

    expect(result.acknowledged).toHaveLength(2)
    expect(result.acknowledged).toContain('replica-a')
    expect(result.acknowledged).toContain('replica-b')
    expect(result.failed).toEqual([])

    await primaryTransport.shutdown()
    await replicaA.shutdown()
    await replicaB.shutdown()
  })

  it('marks a timed-out replica as failed while others succeed', async () => {
    const network = createInMemoryNetwork()
    const primaryTransport = createInMemoryTransport('primary', network, { requestTimeout: 100 })
    const replicaA = createInMemoryTransport('replica-a', network, { requestTimeout: 100 })
    const replicaB = createInMemoryTransport('replica-b', network, { requestTimeout: 100 })

    await replicaA.listen((message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.ENTRY) {
        respond(createAckMessage(1, 0, 'products', 'replica-a', message.requestId))
      }
    })

    await replicaB.listen((_message: TransportMessage, _respond) => {
      /* intentionally does not respond, causing timeout */
    })

    const result = await replicateToReplicas(makeEntry(), ['replica-a', 'replica-b'], primaryTransport, 'primary')

    expect(result.acknowledged).toEqual(['replica-a'])
    expect(result.failed).toEqual(['replica-b'])

    await primaryTransport.shutdown()
    await replicaA.shutdown()
    await replicaB.shutdown()
  })

  it('marks a replica as failed when transport throws', async () => {
    const network = createInMemoryNetwork()
    const primaryTransport = createInMemoryTransport('primary', network)

    const result = await replicateToReplicas(makeEntry(), ['nonexistent-replica'], primaryTransport, 'primary')

    expect(result.acknowledged).toEqual([])
    expect(result.failed).toEqual(['nonexistent-replica'])

    await primaryTransport.shutdown()
  })

  it('propagates programming errors (non-TransportError) instead of swallowing them', async () => {
    const fakeTransport = {
      async send(_target: string, _message: TransportMessage): Promise<TransportMessage> {
        throw new TypeError('unexpected null reference')
      },
      async stream() {},
      async listen() {},
      async shutdown() {},
    }

    await expect(replicateToReplicas(makeEntry(), ['replica-a'], fakeTransport, 'primary')).rejects.toThrow(
      'unexpected null reference',
    )
  })

  it('deduplicates replica IDs so each receives only one message', async () => {
    const network = createInMemoryNetwork()
    const primaryTransport = createInMemoryTransport('primary', network)
    const replicaTransport = createInMemoryTransport('replica-a', network)

    let messageCount = 0
    await replicaTransport.listen((message: TransportMessage, respond) => {
      if (message.type === ReplicationMessageTypes.ENTRY) {
        messageCount++
        respond(createAckMessage(1, 0, 'products', 'replica-a', message.requestId))
      }
    })

    const result = await replicateToReplicas(
      makeEntry(),
      ['replica-a', 'replica-a', 'replica-a'],
      primaryTransport,
      'primary',
    )

    expect(result.acknowledged).toEqual(['replica-a'])
    expect(result.acknowledged).toHaveLength(1)
    expect(result.failed).toEqual([])
    expect(messageCount).toBe(1)

    await primaryTransport.shutdown()
    await replicaTransport.shutdown()
  })
})
