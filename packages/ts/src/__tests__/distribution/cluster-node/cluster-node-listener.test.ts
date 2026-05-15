import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import { createMultiplexedControllerTransport } from '../../../distribution/cluster-node/transport-listener'
import type { ClusterNode, ClusterNodeConfig } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import { createForwardMessage } from '../../../distribution/replication/codec'
import type { InMemoryNetwork } from '../../../distribution/transport'
import {
  ClusterMessageTypes,
  createInMemoryNetwork,
  createInMemoryTransport,
  ReplicationMessageTypes,
} from '../../../distribution/transport'
import type {
  InsyncConfirmPayload,
  InsyncRemovePayload,
  NodeTransport,
  TransportMessage,
} from '../../../distribution/transport/types'

function makeConfig(
  overrides: Partial<ClusterNodeConfig> & {
    coordinator: ClusterCoordinator
    transport: NodeTransport
    address: string
  },
): ClusterNodeConfig {
  return {
    roles: ['data', 'controller'],
    ...overrides,
  }
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

function makeAllocationTable(assignments: Map<number, PartitionAssignment>): AllocationTable {
  return {
    indexName: 'products',
    version: 1,
    replicationFactor: 1,
    assignments,
  }
}

describe('cluster-node transport listener composition', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transportA: NodeTransport
  let transportB: NodeTransport
  let nodeB: ClusterNode | undefined

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transportA = createInMemoryTransport('node-a', network, { requestTimeout: 500 })
    transportB = createInMemoryTransport('node-b', network, { requestTimeout: 500 })
  })

  afterEach(async () => {
    if (nodeB !== undefined) {
      await nodeB.shutdown()
      nodeB = undefined
    }
    await transportA.shutdown()
    await transportB.shutdown()
    await coordinator.shutdown()
  })

  it('keeps data and active-controller handlers reachable on a mixed-role node', async () => {
    nodeB = await createClusterNode(
      makeConfig({
        coordinator,
        transport: transportB,
        address: 'node-b:9200',
        nodeId: 'node-b',
      }),
    )

    await nodeB.start()
    await nodeB.createIndex('products', { schema: { title: 'string' } })

    const forwardMessage = createForwardMessage(
      {
        indexName: 'products',
        documentId: 'forwarded-doc',
        operation: 'insert',
        document: encode({ title: 'Mixed Role' }),
        updateFields: null,
      },
      'node-a',
    )

    const forwardResponse = await transportA.send('node-b', forwardMessage)
    const forwardPayload = decode(forwardResponse.payload) as Record<string, unknown>
    expect(forwardPayload.documentId).toBe('forwarded-doc')
    expect(forwardPayload.success).toBe(true)

    const assignments = new Map<number, PartitionAssignment>()
    assignments.set(
      0,
      makeAssignment({
        primary: 'node-a',
        replicas: ['node-b'],
        inSyncSet: ['node-b'],
        state: 'ACTIVE',
      }),
    )
    await coordinator.putAllocation('products', makeAllocationTable(assignments))

    const insyncPayload: InsyncRemovePayload = {
      indexName: 'products',
      partitionId: 0,
      replicaNodeId: 'node-b',
      primaryTerm: 1,
    }
    const insyncMessage: TransportMessage = {
      type: ReplicationMessageTypes.INSYNC_REMOVE,
      sourceId: 'node-a',
      requestId: 'insync-mixed-role',
      payload: encode(insyncPayload),
    }

    const insyncResponse = await transportA.send('node-b', insyncMessage)
    const confirmPayload = decode(insyncResponse.payload) as InsyncConfirmPayload
    expect(confirmPayload.accepted).toBe(true)

    const updatedTable = await coordinator.getAllocation('products')
    const updatedAssignment = updatedTable?.assignments.get(0)
    expect(updatedAssignment?.inSyncSet).not.toContain('node-b')
  })
})

describe('createMultiplexedControllerTransport dispatch guard', () => {
  it('routes controller message types only to the controller handler, and all others only to the data handler', async () => {
    const baseTransport: NodeTransport = {
      async send() {
        throw new Error('not used')
      },
      async stream() {
        throw new Error('not used')
      },
      async listen() {
        return () => {}
      },
      async shutdown() {},
    }

    const multiplexed = createMultiplexedControllerTransport(baseTransport)
    const dataHandler = vi.fn(async () => {})
    const controllerHandler = vi.fn(async () => {})

    await multiplexed.transport.listen(controllerHandler)
    const wrapped = multiplexed.createHandler(dataHandler)

    const forwardMsg: TransportMessage = {
      type: ReplicationMessageTypes.FORWARD,
      sourceId: 'node-x',
      requestId: 'req-1',
      payload: new Uint8Array(),
    }
    const insyncMsg: TransportMessage = {
      type: ReplicationMessageTypes.INSYNC_REMOVE,
      sourceId: 'node-x',
      requestId: 'req-2',
      payload: new Uint8Array(),
    }
    const bootstrapMsg: TransportMessage = {
      type: ClusterMessageTypes.BOOTSTRAP_COMPLETE,
      sourceId: 'node-x',
      requestId: 'req-3',
      payload: new Uint8Array(),
    }

    await wrapped(forwardMsg, () => {})
    expect(dataHandler).toHaveBeenCalledTimes(1)
    expect(controllerHandler).toHaveBeenCalledTimes(0)

    await wrapped(insyncMsg, () => {})
    expect(dataHandler).toHaveBeenCalledTimes(1)
    expect(controllerHandler).toHaveBeenCalledTimes(1)

    await wrapped(bootstrapMsg, () => {})
    expect(dataHandler).toHaveBeenCalledTimes(1)
    expect(controllerHandler).toHaveBeenCalledTimes(2)
  })

  it('controller dispatch wraps respond so a handler cannot emit duplicate frames', async () => {
    const baseTransport: NodeTransport = {
      async send() {
        throw new Error('not used')
      },
      async stream() {
        throw new Error('not used')
      },
      async listen() {
        return () => {}
      },
      async shutdown() {},
    }

    const multiplexed = createMultiplexedControllerTransport(baseTransport)

    const controllerHandler = vi.fn(async (_msg: TransportMessage, respond: (r: TransportMessage) => void) => {
      respond({ type: 'controller.reply', sourceId: 'c', requestId: 'r', payload: new Uint8Array() })
      respond({ type: 'controller.duplicate', sourceId: 'c', requestId: 'r', payload: new Uint8Array() })
    })
    await multiplexed.transport.listen(controllerHandler)
    const wrapped = multiplexed.createHandler(async () => {})

    const received: TransportMessage[] = []
    await wrapped(
      {
        type: ClusterMessageTypes.BOOTSTRAP_COMPLETE,
        sourceId: 'node-x',
        requestId: 'req-dup',
        payload: new Uint8Array(),
      },
      (r: TransportMessage) => {
        received.push(r)
      },
    )

    expect(received.length).toBe(1)
    expect(received[0].type).toBe('controller.reply')
  })
})
