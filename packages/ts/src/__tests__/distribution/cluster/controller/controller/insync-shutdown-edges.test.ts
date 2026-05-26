import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControllerConfig, ControllerNode } from '../../../../../distribution/cluster/controller'
import {
  CONTROLLER_LEASE_KEY,
  createController,
  putIndexMetadata,
} from '../../../../../distribution/cluster/controller'
import { createInMemoryCoordinator } from '../../../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport, TransportMessage } from '../../../../../distribution/transport'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  ReplicationMessageTypes,
} from '../../../../../distribution/transport'
import type { InsyncConfirmPayload, InsyncRemovePayload } from '../../../../../distribution/transport/types'
import {
  flushPromises,
  makeAllocationTable,
  makeIndexMetadata,
  makeNode,
  setupIndexWithAllocation,
  testSchema,
} from './fixtures'

describe('Controller insync removal, shutdown, and edge cases', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let controllerTransport: NodeTransport
  let controller: ControllerNode | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    controllerTransport = createInMemoryTransport('controller-node', network)
  })

  afterEach(async () => {
    if (controller !== undefined) {
      await controller.shutdown()
      controller = undefined
    }
    await controllerTransport.shutdown()
    await coordinator.shutdown()
    vi.useRealTimers()
  })

  function createDefaultController(overrides: Partial<ControllerConfig> = {}): ControllerNode {
    controller = createController({
      nodeId: 'controller-node',
      coordinator,
      transport: controllerTransport,
      leaseTtlMs: 15_000,
      standbyRetryMs: 5_000,
      knownIndexNames: [],
      ...overrides,
    })
    return controller
  }

  describe('insync removal', () => {
    it('handles INSYNC_REMOVE messages via transport', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))

      const table = makeAllocationTable('products', ['data-1', 'data-2'], 1)
      await coordinator.putAllocation('products', table)

      createDefaultController({ knownIndexNames: ['products'] })
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      const primaryTransport = createInMemoryTransport('data-1', network)

      const insyncPayload: InsyncRemovePayload = {
        indexName: 'products',
        partitionId: 0,
        replicaNodeId: 'data-2',
        primaryTerm: 1,
      }

      const request: TransportMessage = {
        type: ReplicationMessageTypes.INSYNC_REMOVE,
        sourceId: 'data-1',
        requestId: 'req-insync-001',
        payload: encode(insyncPayload),
      }

      const response = await primaryTransport.send('controller-node', request)

      expect(response.type).toBe(ReplicationMessageTypes.INSYNC_CONFIRM)
      expect(response.requestId).toBe('req-insync-001')

      const confirmPayload = decode(response.payload) as InsyncConfirmPayload
      expect(confirmPayload.accepted).toBe(true)
      expect(confirmPayload.indexName).toBe('products')
      expect(confirmPayload.partitionId).toBe(0)

      const updatedTable = await coordinator.getAllocation('products')
      const assignment = updatedTable?.assignments.get(0)
      expect(assignment?.inSyncSet).not.toContain('data-2')

      await primaryTransport.shutdown()
    })

    it('rejects INSYNC_REMOVE with wrong primaryTerm', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))

      const table = makeAllocationTable('products', ['data-1', 'data-2'], 1)
      await coordinator.putAllocation('products', table)

      createDefaultController({ knownIndexNames: ['products'] })
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      const primaryTransport = createInMemoryTransport('data-1', network)

      const insyncPayload: InsyncRemovePayload = {
        indexName: 'products',
        partitionId: 0,
        replicaNodeId: 'data-2',
        primaryTerm: 999,
      }

      const request: TransportMessage = {
        type: ReplicationMessageTypes.INSYNC_REMOVE,
        sourceId: 'data-1',
        requestId: 'req-insync-002',
        payload: encode(insyncPayload),
      }

      const response = await primaryTransport.send('controller-node', request)
      const confirmPayload = decode(response.payload) as InsyncConfirmPayload
      expect(confirmPayload.accepted).toBe(false)

      await primaryTransport.shutdown()
    })
  })

  describe('shutdown', () => {
    it('releases the lease and becomes inactive', async () => {
      createDefaultController()
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()
      expect(controller.isActive).toBe(true)

      await controller.shutdown()

      expect(controller.isActive).toBe(false)
      const holder = await coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
      expect(holder).toBeNull()
    })

    it('is idempotent', async () => {
      createDefaultController()
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      await controller.shutdown()
      await controller.shutdown()
      await controller.shutdown()

      expect(controller.isActive).toBe(false)
    })

    it('prevents standby retry after shutdown', async () => {
      await coordinator.acquireLease(CONTROLLER_LEASE_KEY, 'other-node', 15_000)

      createDefaultController({ standbyRetryMs: 1_000 })
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()
      expect(controller.isActive).toBe(false)

      await controller.shutdown()

      await coordinator.releaseLease(CONTROLLER_LEASE_KEY)
      vi.advanceTimersByTime(2_000)
      await flushPromises()

      expect(controller.isActive).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('handles node_left for a node not in any allocation', async () => {
      await coordinator.registerNode(makeNode('data-1'))
      await coordinator.registerNode(makeNode('data-2'))

      await setupIndexWithAllocation(coordinator, 'products', ['data-1', 'data-2'])

      createDefaultController({ knownIndexNames: ['products'] })
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()

      await coordinator.registerNode(makeNode('data-unknown'))
      vi.advanceTimersByTime(501)
      await flushPromises()
      await coordinator.deregisterNode('data-unknown')
      vi.advanceTimersByTime(501)
      await flushPromises()
      await flushPromises()

      const table = await coordinator.getAllocation('products')
      expect(table).not.toBeNull()
      for (const assignment of table?.assignments.values() ?? []) {
        expect(assignment.primary).not.toBeNull()
      }
    })

    it('handles no data nodes gracefully on schema_created', async () => {
      createDefaultController()
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()
      expect(controller.isActive).toBe(true)

      await putIndexMetadata(coordinator, makeIndexMetadata('products', 2, 0))
      await coordinator.putSchema('products', testSchema)
      await flushPromises()
      await flushPromises()

      const table = await coordinator.getAllocation('products')
      expect(table).toBeNull()
    })

    it('can restart after shutdown', async () => {
      createDefaultController()
      if (controller === undefined) throw new Error('controller not initialised')
      await controller.start()
      expect(controller.isActive).toBe(true)

      await controller.shutdown()
      expect(controller.isActive).toBe(false)

      await controller.start()
      expect(controller.isActive).toBe(true)
    })
  })
})
