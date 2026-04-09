import { afterEach, describe, expect, it } from 'vitest'
import { createInMemoryCoordinator } from '../../../distribution/coordinator/in-memory'
import type { AllocationTable, ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInsyncConfirmMessage, decodePayload } from '../../../distribution/replication/codec'
import { handleInsyncRemoval, requestInsyncRemoval } from '../../../distribution/replication/insync'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport/in-memory'
import type { InsyncRemovePayload, NodeTransport } from '../../../distribution/transport/types'
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
