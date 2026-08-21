import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControllerConfig, ControllerNode } from '../../../../../distribution/cluster/controller'
import { createController } from '../../../../../distribution/cluster/controller'
import { createInMemoryCoordinator } from '../../../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator } from '../../../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport, TransportMessage } from '../../../../../distribution/transport'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  ReplicationMessageTypes,
} from '../../../../../distribution/transport'
import type { InsyncAddPayload, InsyncConfirmPayload } from '../../../../../distribution/transport/types'
import { makeAllocationTable, makeNode } from './fixtures'

describe('controller in-sync message guards', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let controllerTransport: NodeTransport
  let primaryTransport: NodeTransport
  let controller: ControllerNode | undefined

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    controllerTransport = createInMemoryTransport('controller-node', network)
    primaryTransport = createInMemoryTransport('data-1', network)
  })

  afterEach(async () => {
    if (controller !== undefined) {
      await controller.shutdown()
      controller = undefined
    }
    await primaryTransport.shutdown()
    await controllerTransport.shutdown()
    await coordinator.shutdown()
  })

  function createDefaultController(overrides: Partial<ControllerConfig> = {}): ControllerNode {
    controller = createController({
      nodeId: 'controller-node',
      coordinator,
      transport: controllerTransport,
      leaseTtlMs: 15_000,
      standbyRetryMs: 5_000,
      knownIndexNames: ['products'],
      ...overrides,
    })
    return controller
  }

  async function seedAllocation(): Promise<void> {
    await coordinator.registerNode(makeNode('data-1'))
    await coordinator.registerNode(makeNode('data-2'))
    await coordinator.putAllocation('products', makeAllocationTable('products', ['data-1', 'data-2'], 1))
  }

  function makeAddRequest(overrides: Partial<InsyncAddPayload> = {}, sourceId = 'data-1'): TransportMessage {
    const payload: InsyncAddPayload = {
      indexName: 'products',
      partitionId: 0,
      replicaNodeId: 'data-2',
      primaryTerm: 1,
      appliedSeqNo: 0,
      commitPoint: 0,
      ...overrides,
    }
    return {
      type: ReplicationMessageTypes.INSYNC_ADD,
      sourceId,
      requestId: 'req-add-1',
      payload: encode(payload),
    }
  }

  function makeRemoveRequest(payload: unknown, sourceId = 'data-1'): TransportMessage {
    return {
      type: ReplicationMessageTypes.INSYNC_REMOVE,
      sourceId,
      requestId: 'req-remove-1',
      payload: encode(payload),
    }
  }

  it('answers a removal request whose sender does not lead the partition', async () => {
    await seedAllocation()
    await createDefaultController().start()

    const response = await primaryTransport.send(
      'controller-node',
      makeRemoveRequest({ indexName: 'products', partitionId: 0, replicaNodeId: 'data-2', primaryTerm: 1 }, 'data-2'),
    )

    const confirm = decode(response.payload) as InsyncConfirmPayload
    expect(confirm.accepted).toBe(false)
    expect(confirm.indexName).toBe('products')
    expect(confirm.partitionId).toBe(0)
  })

  it('answers a removal request whose payload fails validation', async () => {
    await seedAllocation()
    await createDefaultController().start()

    const response = await primaryTransport.send(
      'controller-node',
      makeRemoveRequest({ indexName: 'products', partitionId: 0, replicaNodeId: 'data-2', primaryTerm: 'first' }),
    )

    const confirm = decode(response.payload) as InsyncConfirmPayload
    expect(confirm.accepted).toBe(false)
    expect(confirm.indexName).toBe('products')
    expect(confirm.partitionId).toBe(0)
  })

  it('refuses an admission once the controller has lost leadership', async () => {
    await seedAllocation()
    const node = createDefaultController()
    await node.start()

    const readAllocation = coordinator.getAllocation.bind(coordinator)
    let steppedDown = false
    coordinator.getAllocation = async (indexName: string): Promise<AllocationTable | null> => {
      const table = await readAllocation(indexName)
      if (!steppedDown) {
        steppedDown = true
        void node.stop()
      }
      return table
    }

    const response = await primaryTransport.send('controller-node', makeAddRequest())
    coordinator.getAllocation = readAllocation

    const confirm = decode(response.payload) as InsyncConfirmPayload
    expect(confirm.accepted).toBe(false)

    const stored = await coordinator.getAllocation('products')
    expect(stored?.assignments.get(0)?.inSyncSet).toEqual(['data-2'])
    expect(stored?.version).toBe(1)
  })

  it('drops every registered watcher when the event loop fails to start', async () => {
    await seedAllocation()
    const unwatchNodes = vi.fn()
    coordinator.watchNodes = async () => unwatchNodes
    controllerTransport.listen = async () => {
      throw new Error('transport refused to listen')
    }

    const node = createDefaultController()
    await expect(node.start()).rejects.toThrow('transport refused to listen')

    expect(unwatchNodes).toHaveBeenCalledTimes(1)
    expect(node.isActive).toBe(false)
  })
})
