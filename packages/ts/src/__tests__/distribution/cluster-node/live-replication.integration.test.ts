import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import { fetchSnapshotFromAnyTarget } from '../../../distribution/cluster-node/bootstrap-fetch'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { resolvePartitionId } from '../../../distribution/cluster-node/write-routing'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'

const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 15_000

async function pollUntil(predicate: () => Promise<boolean> | boolean): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    const result = await predicate()
    if (result) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

function makeAssignment(overrides: Partial<PartitionAssignment> = {}): PartitionAssignment {
  return {
    primary: null,
    replicas: [],
    inSyncSet: [],
    state: 'UNASSIGNED',
    primaryTerm: 1,
    ...overrides,
  }
}

function makeAllocationTable(
  indexName: string,
  assignments: Map<number, PartitionAssignment>,
  version = 1,
): AllocationTable {
  return {
    indexName,
    version,
    replicationFactor: 1,
    assignments,
  }
}

function docIdForPartition(partitionId: number, partitionCount: number, prefix = 'doc'): string {
  for (let i = 0; i < 10_000; i += 1) {
    const candidate = `${prefix}-${partitionId}-${i}`
    if (resolvePartitionId(candidate, partitionCount) === partitionId) {
      return candidate
    }
  }
  throw new Error(`Could not find document id for partition ${partitionId}`)
}

function findNodeAPrimaryPartition(allocation: AllocationTable): number {
  for (const [partitionId, assignment] of allocation.assignments) {
    if (
      assignment.primary === 'node-a' &&
      assignment.replicas.includes('node-b') &&
      assignment.inSyncSet.includes('node-b') &&
      assignment.state === 'ACTIVE'
    ) {
      return partitionId
    }
  }
  throw new Error('No ACTIVE node-a primary partition with node-b in sync')
}

describe('cluster-node live replication', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeA: ClusterNode | undefined
  let nodeB: ClusterNode | undefined
  let transportA: NodeTransport
  let transportB: NodeTransport | undefined

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transportA = createInMemoryTransport('node-a', network)
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
    if (transportB !== undefined) {
      await transportB.shutdown()
      transportB = undefined
    }
    await coordinator.shutdown()
  })

  it('replicates normal primary inserts and removes to an in-sync replica', async () => {
    nodeA = await createClusterNode({
      coordinator,
      transport: transportA,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await nodeA.start()

    await nodeA.createIndex('products', {
      schema: { title: 'string', description: 'string', price: 'number' },
    })

    const replicaTransport = transportB
    if (replicaTransport === undefined) {
      throw new Error('replica transport is not available')
    }

    nodeB = await createClusterNode({
      coordinator,
      transport: replicaTransport,
      address: 'node-b:9200',
      nodeId: 'node-b',
      roles: ['data'],
    })
    await nodeB.start()

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
    const partitionId = findNodeAPrimaryPartition(allocation)
    const docId = docIdForPartition(partitionId, allocation.assignments.size)

    await nodeA.insert(
      'products',
      { title: 'Live Replicated Widget', description: 'normal write path replication', price: 12 },
      docId,
    )

    const replicated = await pollUntil(async () => {
      const result = await nodeB?.query('products', { term: 'Live Replicated' })
      return result?.count === 1
    })
    expect(replicated).toBe(true)

    await nodeA.remove('products', docId)

    const removed = await pollUntil(async () => {
      const result = await nodeB?.query('products', { term: 'Live Replicated' })
      return result?.count === 0
    })
    expect(removed).toBe(true)
  })

  it('continues live replication after a replica bootstraps from a primary with existing log entries', async () => {
    nodeA = await createClusterNode({
      coordinator,
      transport: transportA,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await nodeA.start()
    await nodeA.createIndex('products', { schema: { title: 'string' } })

    const primaryOnlyAssignments = new Map<number, PartitionAssignment>()
    for (let i = 0; i < 5; i += 1) {
      primaryOnlyAssignments.set(i, makeAssignment({ primary: 'node-a', state: 'ACTIVE' }))
    }
    await coordinator.putAllocation('products', makeAllocationTable('products', primaryOnlyAssignments))

    const initialAllocation = await coordinator.getAllocation('products')
    if (initialAllocation === null) {
      throw new Error('products allocation is missing')
    }
    for (const partitionId of initialAllocation.assignments.keys()) {
      const historicalDocId = docIdForPartition(partitionId, initialAllocation.assignments.size)
      await nodeA.insert('products', { title: `Historical ${partitionId}` }, historicalDocId)
    }

    const replicaTransport = transportB
    if (replicaTransport === undefined) {
      throw new Error('replica transport is not available')
    }

    nodeB = await createClusterNode({
      coordinator,
      transport: replicaTransport,
      address: 'node-b:9200',
      nodeId: 'node-b',
      roles: ['data'],
    })
    await nodeB.start()

    const replicaAssignments = new Map<number, PartitionAssignment>()
    for (let i = 0; i < 5; i += 1) {
      replicaAssignments.set(
        i,
        makeAssignment({
          primary: 'node-a',
          replicas: ['node-b'],
          inSyncSet: [],
          state: 'INITIALISING',
        }),
      )
    }
    await coordinator.putAllocation('products', makeAllocationTable('products', replicaAssignments, 2))

    const metadataCheck = await fetchSnapshotFromAnyTarget(
      'products',
      'node-a',
      ['node-a'],
      Date.now() + 10_000,
      { transport: replicaTransport, sourceNodeId: 'node-b' },
      () => false,
      0,
    )
    expect(metadataCheck.ok).toBe(true)
    if (metadataCheck.ok) {
      expect(metadataCheck.header.lastSeqNo).toBe(1)
      expect(metadataCheck.header.partitionId).toBe(0)
    }

    const bootstrapReady = await pollUntil(async () => {
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
    expect(bootstrapReady).toBe(true)

    const allocation = await coordinator.getAllocation('products')
    if (allocation === null) {
      throw new Error('products allocation is missing')
    }
    const partitionId = findNodeAPrimaryPartition(allocation)
    const docId = docIdForPartition(partitionId, allocation.assignments.size, 'live-after-bootstrap')

    await nodeA.insert('products', { title: 'After Bootstrap Live Entry' }, docId)
    const allocationAfterInsert = await coordinator.getAllocation('products')
    expect(allocationAfterInsert?.assignments.get(partitionId)?.inSyncSet).toContain('node-b')

    const replicated = await pollUntil(async () => {
      const result = await nodeB?.query('products', { term: 'After Bootstrap' })
      return result?.count === 1
    })
    expect(replicated).toBe(true)
  })

  it('removes failed replicas from the in-sync set after a primary write replication failure', async () => {
    nodeA = await createClusterNode({
      coordinator,
      transport: transportA,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await nodeA.start()
    await nodeA.createIndex('products', { schema: { title: 'string' } })

    if (transportB !== undefined) {
      await transportB.shutdown()
      transportB = undefined
    }

    const assignments = new Map<number, PartitionAssignment>()
    for (let i = 0; i < 5; i += 1) {
      assignments.set(
        i,
        makeAssignment({
          primary: 'node-a',
          replicas: ['node-b'],
          inSyncSet: ['node-b'],
          state: 'ACTIVE',
        }),
      )
    }
    await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

    const docId = docIdForPartition(0, assignments.size)
    await nodeA.insert('products', { title: 'Replica Failure Survivable' }, docId)

    const allocation = await coordinator.getAllocation('products')
    expect(allocation?.assignments.get(0)?.inSyncSet).not.toContain('node-b')

    const result = await nodeA.query('products', { term: 'Survivable' })
    expect(result.count).toBe(1)
  })
})
