import { afterEach, describe, expect, it } from 'vitest'
import { createInMemoryCoordinator } from '../../../distribution/coordinator/in-memory'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import { createInsyncConfirmMessage, decodePayload } from '../../../distribution/replication/codec'
import {
  handleInsyncAdmission,
  handleInsyncRemoval,
  requestInsyncRemoval,
} from '../../../distribution/replication/insync'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport/in-memory'
import type { InsyncAddPayload, InsyncRemovePayload, NodeTransport } from '../../../distribution/transport/types'
import { ReplicationMessageTypes } from '../../../distribution/transport/types'

function makeAllocationTable(overrides?: Partial<AllocationTable>): AllocationTable {
  return {
    indexName: 'products',
    version: 1,
    replicationFactor: 2,
    assignments: new Map([
      [
        0,
        {
          primary: 'node-a',
          replicas: ['node-b', 'node-c'],
          inSyncSet: ['node-b', 'node-c'],
          state: 'ACTIVE',
          primaryTerm: 1,
          commitPoint: 0,
        },
      ],
    ]),
    ...overrides,
  }
}

describe('requestInsyncRemoval', () => {
  let coordinator: ClusterCoordinator
  let network: ReturnType<typeof createInMemoryNetwork>
  let primaryTransport: NodeTransport
  let controllerTransport: NodeTransport

  afterEach(async () => {
    await primaryTransport.shutdown()
    await controllerTransport.shutdown()
    await coordinator.shutdown()
  })

  it('returns accepted: true when controller accepts the removal', async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    primaryTransport = createInMemoryTransport('node-a', network)
    controllerTransport = createInMemoryTransport('controller', network)

    await coordinator.putAllocation('products', makeAllocationTable())

    await controllerTransport.listen(async (message, respond) => {
      if (message.type === ReplicationMessageTypes.INSYNC_REMOVE) {
        const payload = decodePayload<InsyncRemovePayload>(message.payload)
        const confirmPayload = await handleInsyncRemoval(payload, coordinator)
        respond(createInsyncConfirmMessage(confirmPayload, 'controller', message.requestId))
      }
    })

    const result = await requestInsyncRemoval('products', 0, 'node-b', 1, 'controller', primaryTransport, 'node-a')
    expect(result.accepted).toBe(true)
  })

  it('returns accepted: false when primaryTerm is stale', async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    primaryTransport = createInMemoryTransport('node-a', network)
    controllerTransport = createInMemoryTransport('controller', network)

    await coordinator.putAllocation('products', makeAllocationTable())

    await controllerTransport.listen(async (message, respond) => {
      if (message.type === ReplicationMessageTypes.INSYNC_REMOVE) {
        const payload = decodePayload<InsyncRemovePayload>(message.payload)
        const confirmPayload = await handleInsyncRemoval(payload, coordinator)
        respond(createInsyncConfirmMessage(confirmPayload, 'controller', message.requestId))
      }
    })

    const result = await requestInsyncRemoval('products', 0, 'node-b', 99, 'controller', primaryTransport, 'node-a')
    expect(result.accepted).toBe(false)
  })
})

describe('handleInsyncRemoval', () => {
  let coordinator: ClusterCoordinator

  afterEach(async () => {
    await coordinator.shutdown()
  })

  it('removes the replica from the inSyncSet and updates the allocation table', async () => {
    coordinator = createInMemoryCoordinator()
    await coordinator.putAllocation('products', makeAllocationTable())

    const result = await handleInsyncRemoval(
      { indexName: 'products', partitionId: 0, replicaNodeId: 'node-b', primaryTerm: 1 },
      coordinator,
    )

    expect(result.accepted).toBe(true)

    const updatedTable = await coordinator.getAllocation('products')
    expect(updatedTable).not.toBeNull()
    const assignment = updatedTable?.assignments.get(0)
    expect(assignment?.inSyncSet).toEqual(['node-c'])
  })

  it('rejects removal with stale primaryTerm', async () => {
    coordinator = createInMemoryCoordinator()
    await coordinator.putAllocation('products', makeAllocationTable())

    const result = await handleInsyncRemoval(
      { indexName: 'products', partitionId: 0, replicaNodeId: 'node-b', primaryTerm: 99 },
      coordinator,
    )

    expect(result.accepted).toBe(false)

    const unchangedTable = await coordinator.getAllocation('products')
    const assignment = unchangedTable?.assignments.get(0)
    expect(assignment?.inSyncSet).toEqual(['node-b', 'node-c'])
  })

  it('returns accepted: false for unknown index', async () => {
    coordinator = createInMemoryCoordinator()

    const result = await handleInsyncRemoval(
      { indexName: 'unknown-index', partitionId: 0, replicaNodeId: 'node-b', primaryTerm: 1 },
      coordinator,
    )

    expect(result.accepted).toBe(false)
  })

  it('returns accepted: false for unknown partition', async () => {
    coordinator = createInMemoryCoordinator()
    await coordinator.putAllocation('products', makeAllocationTable())

    const result = await handleInsyncRemoval(
      { indexName: 'products', partitionId: 99, replicaNodeId: 'node-b', primaryTerm: 1 },
      coordinator,
    )

    expect(result.accepted).toBe(false)
  })

  it('increments the allocation table version after removal', async () => {
    coordinator = createInMemoryCoordinator()
    await coordinator.putAllocation('products', makeAllocationTable())

    await handleInsyncRemoval(
      { indexName: 'products', partitionId: 0, replicaNodeId: 'node-b', primaryTerm: 1 },
      coordinator,
    )

    const table = await coordinator.getAllocation('products')
    expect(table?.version).toBe(2)
  })
})

describe('handleInsyncAdmission', () => {
  let coordinator: ClusterCoordinator

  afterEach(async () => {
    await coordinator.shutdown()
  })

  async function admit(
    table: AllocationTable,
    payload: Partial<InsyncAddPayload> = {},
  ): Promise<{ accepted: boolean; inSyncSet: string[]; commitPoint: number; version: number }> {
    coordinator = createInMemoryCoordinator()
    await coordinator.putAllocation('products', table)
    const confirm = await handleInsyncAdmission(
      {
        indexName: 'products',
        partitionId: 0,
        replicaNodeId: 'node-d',
        primaryTerm: 1,
        appliedSeqNo: 10,
        commitPoint: 10,
        ...payload,
      },
      coordinator,
    )
    const stored = await coordinator.getAllocation('products')
    const assignment = stored?.assignments.get(0)
    return {
      accepted: confirm.accepted,
      inSyncSet: assignment?.inSyncSet ?? [],
      commitPoint: assignment?.commitPoint ?? -1,
      version: stored?.version ?? -1,
    }
  }

  function tableWith(assignment: Partial<PartitionAssignment>): AllocationTable {
    const base = makeAllocationTable()
    const existing = base.assignments.get(0)
    if (existing === undefined) throw new Error('expected partition 0')
    base.assignments.set(0, { ...existing, ...assignment })
    return base
  }

  it('admits an assigned replica that has reached the commit point', async () => {
    const result = await admit(tableWith({ replicas: ['node-b', 'node-c', 'node-d'], commitPoint: 10 }))
    expect(result.accepted).toBe(true)
    expect(result.inSyncSet).toContain('node-d')
  })

  it("records the primary's commit point as the new floor", async () => {
    const result = await admit(tableWith({ replicas: ['node-b', 'node-c', 'node-d'], commitPoint: 4 }))
    expect(result.accepted).toBe(true)
    expect(result.commitPoint).toBe(10)
  })

  it("refuses a replica behind the primary's own commit point", async () => {
    const result = await admit(tableWith({ replicas: ['node-b', 'node-c', 'node-d'], commitPoint: 0 }), {
      appliedSeqNo: 5,
      commitPoint: 10,
    })
    expect(result.accepted).toBe(false)
    expect(result.inSyncSet).not.toContain('node-d')
  })

  it('refuses a replica whose applied position is behind the commit point', async () => {
    const result = await admit(tableWith({ replicas: ['node-b', 'node-c', 'node-d'], commitPoint: 20 }))
    expect(result.accepted).toBe(false)
    expect(result.inSyncSet).not.toContain('node-d')
  })

  it('refuses a node that is not an assigned replica', async () => {
    const result = await admit(tableWith({ commitPoint: 0 }))
    expect(result.accepted).toBe(false)
    expect(result.inSyncSet).not.toContain('node-d')
  })

  it('refuses a stale primary term', async () => {
    const result = await admit(tableWith({ replicas: ['node-b', 'node-c', 'node-d'], primaryTerm: 2 }))
    expect(result.accepted).toBe(false)
    expect(result.inSyncSet).not.toContain('node-d')
  })

  it('refuses a partition that is not ACTIVE', async () => {
    const result = await admit(tableWith({ replicas: ['node-b', 'node-c', 'node-d'], state: 'MIGRATING' }))
    expect(result.accepted).toBe(false)
    expect(result.inSyncSet).not.toContain('node-d')
  })

  it('accepts without writing when the replica is already in the set at the same commit point', async () => {
    const result = await admit(
      tableWith({
        replicas: ['node-b', 'node-c', 'node-d'],
        inSyncSet: ['node-b', 'node-c', 'node-d'],
        commitPoint: 10,
      }),
    )
    expect(result.accepted).toBe(true)
    expect(result.inSyncSet).toEqual(['node-b', 'node-c', 'node-d'])
    expect(result.version).toBe(1)
  })

  it('raises the commit point when a replica already in the set repeats its request', async () => {
    const result = await admit(
      tableWith({
        replicas: ['node-b', 'node-c', 'node-d'],
        inSyncSet: ['node-b', 'node-c', 'node-d'],
        commitPoint: 4,
      }),
    )
    expect(result.accepted).toBe(true)
    expect(result.inSyncSet).toEqual(['node-b', 'node-c', 'node-d'])
    expect(result.commitPoint).toBe(10)
    expect(result.version).toBe(2)
  })

  it('leaves the commit point alone when a repeated request carries a lower value', async () => {
    const result = await admit(
      tableWith({
        replicas: ['node-b', 'node-c', 'node-d'],
        inSyncSet: ['node-b', 'node-c', 'node-d'],
        commitPoint: 10,
      }),
      { appliedSeqNo: 12, commitPoint: 6 },
    )
    expect(result.accepted).toBe(true)
    expect(result.commitPoint).toBe(10)
    expect(result.version).toBe(1)
  })

  it('refuses an unknown index', async () => {
    const result = await admit(makeAllocationTable(), { indexName: 'products', partitionId: 7 })
    expect(result.accepted).toBe(false)
  })
})
