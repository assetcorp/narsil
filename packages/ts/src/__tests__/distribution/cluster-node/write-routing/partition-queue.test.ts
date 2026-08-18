import { describe, expect, it } from 'vitest'
import {
  createPartitionWriteQueues,
  enqueuePartitionWrite,
} from '../../../../distribution/cluster-node/write-routing/partition-queue'
import { chunkReplicationEntries } from '../../../../distribution/cluster-node/write-routing/replication'
import type { ReplicationLogEntry } from '../../../../distribution/replication/types'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>(promiseResolve => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('enqueuePartitionWrite', () => {
  it('runs tasks for one partition strictly in order', async () => {
    const queues = createPartitionWriteQueues()
    const order: number[] = []
    const firstGate = deferred()

    const first = enqueuePartitionWrite(queues, 'products', 0, async () => {
      await firstGate.promise
      order.push(1)
    })
    const second = enqueuePartitionWrite(queues, 'products', 0, async () => {
      order.push(2)
    })

    firstGate.resolve()
    await Promise.all([first, second])

    expect(order).toEqual([1, 2])
  })

  it('runs tasks for different partitions independently', async () => {
    const queues = createPartitionWriteQueues()
    const order: string[] = []
    const blockedGate = deferred()

    const blocked = enqueuePartitionWrite(queues, 'products', 0, async () => {
      await blockedGate.promise
      order.push('partition-0')
    })
    await enqueuePartitionWrite(queues, 'products', 1, async () => {
      order.push('partition-1')
    })

    blockedGate.resolve()
    await blocked

    expect(order).toEqual(['partition-1', 'partition-0'])
  })

  it('keeps running after a task rejects', async () => {
    const queues = createPartitionWriteQueues()

    await expect(
      enqueuePartitionWrite(queues, 'products', 0, () => Promise.reject(new Error('replication failed'))),
    ).rejects.toThrow('replication failed')

    const result = await enqueuePartitionWrite(queues, 'products', 0, async () => 'recovered')
    expect(result).toBe('recovered')
  })

  it('cleans up the chain map once the last task settles', async () => {
    const queues = createPartitionWriteQueues()

    await enqueuePartitionWrite(queues, 'products', 0, async () => undefined)
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(queues.chains.size).toBe(0)
  })
})

describe('chunkReplicationEntries', () => {
  function makeItem(seqNo: number, documentBytes = 100): { entry: ReplicationLogEntry } {
    return {
      entry: {
        seqNo,
        primaryTerm: 1,
        operation: 'INDEX',
        partitionId: 0,
        indexName: 'products',
        documentId: `doc-${seqNo}`,
        document: new Uint8Array(documentBytes),
        checksum: 1,
      },
    }
  }

  it('keeps a small contiguous run in one chunk', () => {
    const items = [makeItem(1), makeItem(2), makeItem(3)]
    expect(chunkReplicationEntries(items)).toEqual([items])
  })

  it('splits at a sequence-number gap', () => {
    const items = [makeItem(1), makeItem(2), makeItem(4)]
    const chunks = chunkReplicationEntries(items)

    expect(chunks).toHaveLength(2)
    expect(chunks[0].map(item => item.entry.seqNo)).toEqual([1, 2])
    expect(chunks[1].map(item => item.entry.seqNo)).toEqual([4])
  })

  it('splits once a chunk reaches the entry count limit', () => {
    const items = Array.from({ length: 1_500 }, (_, index) => makeItem(index + 1, 0))
    const chunks = chunkReplicationEntries(items)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(1_000)
    expect(chunks[1]).toHaveLength(500)
  })

  it('splits once a chunk reaches the byte budget', () => {
    const threeMegabytes = 3 * 1_024 * 1_024
    const items = [makeItem(1, threeMegabytes), makeItem(2, threeMegabytes), makeItem(3, threeMegabytes)]
    const chunks = chunkReplicationEntries(items)

    expect(chunks).toHaveLength(2)
    expect(chunks[0].map(item => item.entry.seqNo)).toEqual([1, 2])
    expect(chunks[1].map(item => item.entry.seqNo)).toEqual([3])
  })

  it('returns no chunks for no entries', () => {
    expect(chunkReplicationEntries([])).toEqual([])
  })
})
