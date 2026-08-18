import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { resolvePartitionId } from '../../../distribution/cluster-node/write-routing'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport, TransportMessage } from '../../../distribution/transport/types'
import { ReplicationMessageTypes } from '../../../distribution/transport/types'

const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 15_000

async function pollUntil(predicate: () => Promise<boolean> | boolean): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

function docIdsForPartition(partitionId: number, partitionCount: number, count: number): string[] {
  const ids: string[] = []
  for (let candidateIndex = 0; ids.length < count && candidateIndex < 100_000; candidateIndex += 1) {
    const candidate = `doc-${partitionId}-${candidateIndex}`
    if (resolvePartitionId(candidate, partitionCount) === partitionId) {
      ids.push(candidate)
    }
  }
  if (ids.length < count) {
    throw new Error(`Could not find ${count} document ids for partition ${partitionId}`)
  }
  return ids
}

function recordingTransport(inner: NodeTransport, recordedTypes: string[]): NodeTransport {
  return {
    send: (target: string, message: TransportMessage) => {
      recordedTypes.push(message.type)
      return inner.send(target, message)
    },
    stream: (target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void) =>
      inner.stream(target, message, handler),
    listen: handler => inner.listen(handler),
    shutdown: () => inner.shutdown(),
  }
}

describe('cluster-node batch replication', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeA: ClusterNode | undefined
  let nodeB: ClusterNode | undefined
  let transportA: NodeTransport
  let transportB: NodeTransport
  let recordedTypes: string[]

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    recordedTypes = []
    transportA = recordingTransport(createInMemoryTransport('node-a', network), recordedTypes)
    transportB = createInMemoryTransport('node-b', network)
  })

  afterEach(async () => {
    if (nodeA !== undefined) {
      await nodeA.shutdown()
      nodeA = undefined
    }
    if (nodeB !== undefined) {
      await nodeB.shutdown()
      nodeB = undefined
    }
    await transportA.shutdown()
    await transportB.shutdown()
    await coordinator.shutdown()
  })

  it('replicates a batch insert as one entry batch per partition and a batch remove the same way', async () => {
    nodeA = await createClusterNode({
      coordinator,
      transport: transportA,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await nodeA.start()
    await nodeA.createIndex('products', { schema: { title: 'string', price: 'number' } })

    nodeB = await createClusterNode({
      coordinator,
      transport: transportB,
      address: 'node-b:9200',
      nodeId: 'node-b',
      roles: ['data'],
    })
    await nodeB.start()

    const inSync = await pollUntil(async () => {
      const allocation = await coordinator.getAllocation('products')
      if (allocation === null || allocation.assignments.size === 0) return false
      for (const assignment of allocation.assignments.values()) {
        if (assignment.state !== 'ACTIVE' || !assignment.inSyncSet.includes('node-b')) return false
      }
      return true
    })
    expect(inSync).toBe(true)

    const allocation = await coordinator.getAllocation('products')
    if (allocation === null) throw new Error('products allocation is missing')
    const partitionCount = allocation.assignments.size
    const nodeAPrimaryPartitions: number[] = []
    for (const [partitionId, assignment] of allocation.assignments) {
      if (assignment.primary === 'node-a') {
        nodeAPrimaryPartitions.push(partitionId)
      }
    }
    expect(nodeAPrimaryPartitions.length).toBeGreaterThan(0)

    const DOCS_PER_PARTITION = 4
    const documents: Array<{ id: string; title: string; price: number }> = []
    for (let partitionId = 0; partitionId < partitionCount; partitionId += 1) {
      for (const id of docIdsForPartition(partitionId, partitionCount, DOCS_PER_PARTITION)) {
        documents.push({ id, title: `Batched Widget ${id}`, price: 10 })
      }
    }

    recordedTypes.length = 0
    const insertResult = await nodeA.insertBatch('products', documents)

    expect(insertResult.failed).toEqual([])
    expect(insertResult.succeeded).toHaveLength(documents.length)

    const insertBatchMessages = recordedTypes.filter(type => type === ReplicationMessageTypes.ENTRY_BATCH)
    const insertEntryMessages = recordedTypes.filter(type => type === ReplicationMessageTypes.ENTRY)
    expect(insertBatchMessages).toHaveLength(nodeAPrimaryPartitions.length)
    expect(insertEntryMessages).toHaveLength(0)

    const replicated = await pollUntil(async () => {
      const result = await nodeB?.query('products', { term: 'Batched' })
      return result?.count === documents.length
    })
    expect(replicated).toBe(true)

    recordedTypes.length = 0
    const removeResult = await nodeA.removeBatch(
      'products',
      documents.map(doc => doc.id),
    )

    expect(removeResult.failed).toEqual([])
    expect(removeResult.succeeded).toHaveLength(documents.length)

    const removeBatchMessages = recordedTypes.filter(type => type === ReplicationMessageTypes.ENTRY_BATCH)
    const removeEntryMessages = recordedTypes.filter(type => type === ReplicationMessageTypes.ENTRY)
    expect(removeBatchMessages).toHaveLength(nodeAPrimaryPartitions.length)
    expect(removeEntryMessages).toHaveLength(0)

    const emptied = await pollUntil(async () => {
      const result = await nodeB?.query('products', { term: 'Batched' })
      return result?.count === 0
    })
    expect(emptied).toBe(true)
  }, 30_000)
})
