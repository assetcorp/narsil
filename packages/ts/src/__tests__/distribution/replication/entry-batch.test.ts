import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import {
  createAckMessage,
  createEntryBatchMessage,
  validateEntryBatchPayload,
} from '../../../distribution/replication/codec'
import { replicateBatchToReplicas } from '../../../distribution/replication/primary'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport/in-memory'
import type { TransportMessage } from '../../../distribution/transport/types'
import { ReplicationMessageTypes } from '../../../distribution/transport/types'

function makeEntry(seqNo: number, overrides?: Partial<ReplicationLogEntry>): ReplicationLogEntry {
  return {
    seqNo,
    primaryTerm: 1,
    operation: 'INDEX',
    partitionId: 0,
    indexName: 'products',
    documentId: `doc-${seqNo}`,
    document: encode({ title: 'Wireless Headphones', price: 149 }),
    checksum: 12345,
    ...overrides,
  }
}

describe('validateEntryBatchPayload', () => {
  function roundTrip(entries: ReplicationLogEntry[]): unknown {
    return decode(createEntryBatchMessage(entries, 'primary').payload)
  }

  it('round-trips a contiguous batch', () => {
    const entries = [makeEntry(1), makeEntry(2), makeEntry(3)]
    const validated = validateEntryBatchPayload(roundTrip(entries))

    expect(validated.entries).toHaveLength(3)
    expect(validated.entries.map(entry => entry.seqNo)).toEqual([1, 2, 3])
  })

  it('rejects an empty batch', () => {
    expect(() => validateEntryBatchPayload({ entries: [] })).toThrow('must not be empty')
  })

  it('rejects entries from different partitions', () => {
    const entries = [makeEntry(1), makeEntry(2, { partitionId: 1 })]
    expect(() => validateEntryBatchPayload(roundTrip(entries))).toThrow('one partition of one index')
  })

  it('rejects entries with different primary terms', () => {
    const entries = [makeEntry(1), makeEntry(2, { primaryTerm: 2 })]
    expect(() => validateEntryBatchPayload(roundTrip(entries))).toThrow('one primary term')
  })

  it('rejects non-contiguous sequence numbers', () => {
    const entries = [makeEntry(1), makeEntry(3)]
    expect(() => validateEntryBatchPayload(roundTrip(entries))).toThrow('contiguous ascending')
  })
})

describe('replicateBatchToReplicas', () => {
  it('acknowledges a replica that acks the last entry of the batch', async () => {
    const network = createInMemoryNetwork()
    const primaryTransport = createInMemoryTransport('primary', network)
    const replicaTransport = createInMemoryTransport('replica-a', network)
    const receivedTypes: string[] = []

    await replicaTransport.listen((message: TransportMessage, respond) => {
      receivedTypes.push(message.type)
      if (message.type === ReplicationMessageTypes.ENTRY_BATCH) {
        const payload = validateEntryBatchPayload(decode(message.payload))
        const last = payload.entries[payload.entries.length - 1]
        respond(createAckMessage(last.seqNo, last.partitionId, last.indexName, 'replica-a', message.requestId))
      }
    })

    const entries = [makeEntry(1), makeEntry(2), makeEntry(3)]
    const result = await replicateBatchToReplicas(entries, ['replica-a'], primaryTransport, 'primary')

    expect(result.acknowledged).toEqual(['replica-a'])
    expect(result.failed).toEqual([])
    expect(receivedTypes).toEqual([ReplicationMessageTypes.ENTRY_BATCH])

    await primaryTransport.shutdown()
    await replicaTransport.shutdown()
  })

  it('sends a batch of one as a plain entry message', async () => {
    const network = createInMemoryNetwork()
    const primaryTransport = createInMemoryTransport('primary', network)
    const replicaTransport = createInMemoryTransport('replica-a', network)
    const receivedTypes: string[] = []

    await replicaTransport.listen((message: TransportMessage, respond) => {
      receivedTypes.push(message.type)
      respond(createAckMessage(1, 0, 'products', 'replica-a', message.requestId))
    })

    const result = await replicateBatchToReplicas([makeEntry(1)], ['replica-a'], primaryTransport, 'primary')

    expect(result.acknowledged).toEqual(['replica-a'])
    expect(receivedTypes).toEqual([ReplicationMessageTypes.ENTRY])

    await primaryTransport.shutdown()
    await replicaTransport.shutdown()
  })

  it('marks a replica failed when its ack names an earlier entry', async () => {
    const network = createInMemoryNetwork()
    const primaryTransport = createInMemoryTransport('primary', network)
    const replicaTransport = createInMemoryTransport('replica-a', network)

    await replicaTransport.listen((message: TransportMessage, respond) => {
      respond(createAckMessage(1, 0, 'products', 'replica-a', message.requestId))
    })

    const entries = [makeEntry(1), makeEntry(2)]
    const result = await replicateBatchToReplicas(entries, ['replica-a'], primaryTransport, 'primary')

    expect(result.acknowledged).toEqual([])
    expect(result.failed).toEqual(['replica-a'])

    await primaryTransport.shutdown()
    await replicaTransport.shutdown()
  })

  it('returns empty result for an empty batch', async () => {
    const network = createInMemoryNetwork()
    const transport = createInMemoryTransport('primary', network)

    const result = await replicateBatchToReplicas([], ['replica-a'], transport, 'primary')

    expect(result.acknowledged).toEqual([])
    expect(result.failed).toEqual([])
    await transport.shutdown()
  })
})
