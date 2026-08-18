import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
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
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
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

async function waitForActiveAllocation(coordinator: ClusterCoordinator, indexName: string): Promise<AllocationTable> {
  const ready = await pollUntil(async () => {
    const allocation = await coordinator.getAllocation(indexName)
    if (allocation === null || allocation.assignments.size === 0) return false
    for (const assignment of allocation.assignments.values()) {
      if (assignment.state !== 'ACTIVE') return false
    }
    return true
  })
  expect(ready).toBe(true)
  const allocation = await coordinator.getAllocation(indexName)
  if (allocation === null) throw new Error(`allocation for ${indexName} is missing`)
  return allocation
}

describe('cluster-node document reads', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeA: ClusterNode | undefined
  let nodeB: ClusterNode | undefined
  let transportA: NodeTransport
  let transportB: NodeTransport

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
    await transportB.shutdown()
    await coordinator.shutdown()
  })

  it('reads documents from the local node and through a remote partition holder', async () => {
    nodeA = await createClusterNode({
      coordinator,
      transport: transportA,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await nodeA.start()
    await nodeA.createIndex('products', { schema: { title: 'string', price: 'number' } })
    const allocation = await waitForActiveAllocation(coordinator, 'products')

    const partitionCount = allocation.assignments.size
    const storedId = docIdForPartition(0, partitionCount)
    const missingId = docIdForPartition(1, partitionCount, 'missing')
    await nodeA.insert('products', { title: 'Clustered Widget', price: 12 }, storedId)

    const localRead = await nodeA.get('products', storedId)
    expect(localRead).toMatchObject({ title: 'Clustered Widget', price: 12 })
    expect(await nodeA.has('products', storedId)).toBe(true)
    expect(await nodeA.get('products', missingId)).toBeUndefined()
    expect(await nodeA.has('products', missingId)).toBe(false)

    nodeB = await createClusterNode({
      coordinator,
      transport: transportB,
      address: 'node-b:9200',
      nodeId: 'node-b',
      roles: ['coordinator'],
    })
    await nodeB.start()

    const remoteRead = await nodeB.get('products', storedId)
    expect(remoteRead).toMatchObject({ title: 'Clustered Widget', price: 12 })
    expect(await nodeB.has('products', storedId)).toBe(true)

    const many = await nodeB.getMultiple('products', [storedId, missingId, storedId])
    expect(many.size).toBe(1)
    expect(many.get(storedId)).toMatchObject({ title: 'Clustered Widget' })
  }, 30_000)

  it('fails a read loudly when no active replica serves the partition', async () => {
    nodeA = await createClusterNode({
      coordinator,
      transport: transportA,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data'],
    })
    await nodeA.start()

    const partitionCount = 3
    const assignments = new Map<number, PartitionAssignment>()
    assignments.set(0, { primary: null, replicas: [], inSyncSet: [], state: 'UNASSIGNED', primaryTerm: 1 })
    for (let partitionId = 1; partitionId < partitionCount; partitionId += 1) {
      assignments.set(partitionId, {
        primary: 'node-a',
        replicas: [],
        inSyncSet: [],
        state: 'ACTIVE',
        primaryTerm: 1,
      })
    }
    await coordinator.putAllocation('products', {
      indexName: 'products',
      version: 1,
      replicationFactor: 1,
      assignments,
    })

    const strandedId = docIdForPartition(0, partitionCount, 'stranded')

    await expect(nodeA.get('products', strandedId)).rejects.toMatchObject({ code: 'QUERY_NO_ACTIVE_REPLICA' })
    await expect(nodeA.getMultiple('products', [strandedId])).rejects.toMatchObject({
      code: 'QUERY_NO_ACTIVE_REPLICA',
    })
  }, 30_000)
})
