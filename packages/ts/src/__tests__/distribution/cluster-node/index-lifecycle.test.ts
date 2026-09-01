import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { seedReopenedPrimaryLogs } from '../../../distribution/cluster-node/local-replication'
import { deleteIndexReplicationLogs, getReplicationLog } from '../../../distribution/cluster-node/replication-logs'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { resolvePartitionId } from '../../../distribution/cluster-node/write-routing'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'

const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 15_000

async function pollUntil(predicate: () => Promise<boolean> | boolean): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (await predicate()) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

function docIdForPartition(partitionId: number, partitionCount: number, prefix: string): string {
  for (let i = 0; i < 10_000; i += 1) {
    const candidate = `${prefix}-${i}`
    if (resolvePartitionId(candidate, partitionCount) === partitionId) {
      return candidate
    }
  }
  throw new Error(`Could not find document id for partition ${partitionId}`)
}

function findReplicatedPrimaryPartition(allocation: AllocationTable, primary: string, replica: string): number {
  for (const [partitionId, assignment] of allocation.assignments) {
    if (assignment.primary === primary && assignment.inSyncSet.includes(replica) && assignment.state === 'ACTIVE') {
      return partitionId
    }
  }
  throw new Error(`No ACTIVE partition with primary ${primary} and in-sync replica ${replica}`)
}

describe('cluster-node index lifecycle', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transport: NodeTransport
  let node: ClusterNode | null
  let directory: string

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transport = createInMemoryTransport('node-a', network)
    directory = await mkdtemp(join(tmpdir(), 'narsil-cluster-lifecycle-'))
    node = null
  })

  afterEach(async () => {
    await node?.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
    await rm(directory, { recursive: true, force: true })
  })

  it('closes only the local copy and reopens it for the next cluster read', async () => {
    node = await createClusterNode({
      coordinator,
      transport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
      engine: { durability: { directory }, lifecycle: {} },
    })
    await node.start()
    await node.createIndex('products', { schema: { title: 'string' } })
    await node.insert('products', { title: 'Desk lamp' }, 'lamp')

    await node.close('products')

    expect((await node.getMemoryStats()).openIndexCount).toBe(0)
    expect(await node.countDocuments('products')).toBe(1)
    expect((await node.getMemoryStats()).openIndexCount).toBe(1)
  })

  it('releases the index memory and reopens cleanly when the close hook fails', async () => {
    const engine = await createClusterLocalEngine(
      { durability: { directory }, lifecycle: {} },
      {
        onIndexClose() {
          throw new Error('replication log cleanup failed')
        },
      },
    )
    try {
      await engine.createIndex('products', { schema: { title: 'string' } })
      await engine.insert('products', { title: 'Desk lamp' }, 'lamp')

      await expect(engine.close('products')).rejects.toThrow('replication log cleanup failed')

      const afterClose = await engine.getMemoryStats()
      expect(afterClose.openIndexCount).toBe(0)
      expect(afterClose.estimatedIndexBytes).toBe(0)
      expect(await engine.countDocuments('products')).toBe(1)
      expect((await engine.getMemoryStats()).reopenCount).toBe(1)
    } finally {
      await engine.shutdown()
    }
  })

  it('removes only the closed index replication logs', () => {
    const logs = new Map()
    getReplicationLog(logs, 'products', 0)
    getReplicationLog(logs, 'products-archive', 0)

    deleteIndexReplicationLogs(logs, 'products')

    expect([...logs.keys()]).toEqual(['products-archive:0'])
  })

  it('resumes a reopened primary log above its durable and committed floors', async () => {
    await coordinator.putAllocation('products', {
      indexName: 'products',
      version: 1,
      replicationFactor: 1,
      assignments: new Map([
        [
          0,
          {
            primary: 'node-a',
            replicas: ['node-a'],
            inSyncSet: ['node-a'],
            state: 'ACTIVE',
            primaryTerm: 3,
            commitPoint: 7,
          },
        ],
      ]),
    })
    const logs = new Map()

    await seedReopenedPrimaryLogs({
      indexName: 'products',
      nodeId: 'node-a',
      engine: {
        heldPartitionsOf: () => [0],
        highestPersistedSeqNoOf: () => 9,
      },
      coordinator,
      replicationLogs: logs,
    })
    const entry = getReplicationLog(logs, 'products', 0).append({
      primaryTerm: 3,
      operation: 'DELETE',
      partitionId: 0,
      indexName: 'products',
      documentId: 'lamp',
      document: null,
    })

    expect(entry.seqNo).toBe(10)
  })

  it('replicates a primary write after a close and reopen without disturbing the replica', async () => {
    node = await createClusterNode({
      coordinator,
      transport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
      engine: { durability: { directory }, lifecycle: {} },
    })
    await node.start()
    await node.createIndex('products', { schema: { title: 'string' } })

    const replicaTransport = createInMemoryTransport('node-b', network)
    const replica = await createClusterNode({
      coordinator,
      transport: replicaTransport,
      address: 'node-b:9200',
      nodeId: 'node-b',
      roles: ['data'],
    })
    await replica.start()

    try {
      const ready = await pollUntil(async () => {
        const allocation = await coordinator.getAllocation('products')
        if (allocation === null || allocation.assignments.size === 0) {
          return false
        }
        for (const assignment of allocation.assignments.values()) {
          if (assignment.state !== 'ACTIVE' || !assignment.inSyncSet.includes('node-b')) {
            return false
          }
        }
        return true
      })
      expect(ready).toBe(true)

      const allocation = await coordinator.getAllocation('products')
      if (allocation === null) {
        throw new Error('products allocation is missing')
      }
      const partitionId = findReplicatedPrimaryPartition(allocation, 'node-a', 'node-b')
      const partitionCount = allocation.assignments.size
      const firstDocId = docIdForPartition(partitionId, partitionCount, 'before-close')
      await node.insert('products', { title: 'Desk lamp' }, firstDocId)

      const firstReplicated = await pollUntil(async () => {
        const result = await replica.query('products', { term: 'lamp' })
        return result.count === 1
      })
      expect(firstReplicated).toBe(true)

      await node.close('products')
      expect((await node.getMemoryStats()).openIndexCount).toBe(0)

      const secondDocId = docIdForPartition(partitionId, partitionCount, 'after-reopen')
      await node.insert('products', { title: 'Floor lantern' }, secondDocId)

      const secondReplicated = await pollUntil(async () => {
        const result = await replica.query('products', { term: 'lantern' })
        return result.count === 1
      })
      expect(secondReplicated).toBe(true)

      const allocationAfterReopen = await coordinator.getAllocation('products')
      expect(allocationAfterReopen?.assignments.get(partitionId)?.inSyncSet).toContain('node-b')
      expect(await node.countDocuments('products')).toBe(2)
    } finally {
      await replica.shutdown()
      await replicaTransport.shutdown()
    }
  }, 30_000)
})
