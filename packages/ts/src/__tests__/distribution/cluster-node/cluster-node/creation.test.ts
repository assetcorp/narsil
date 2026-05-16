import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClusterNode } from '../../../../distribution/cluster-node'
import type { ClusterNode } from '../../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../distribution/transport'
import type { NodeTransport } from '../../../../distribution/transport/types'
import { makeConfig } from './fixtures'

describe('createClusterNode (creation, start, controller, createIndex)', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeA: ClusterNode | undefined
  let nodeB: ClusterNode | undefined
  let transportA: NodeTransport
  let transportB: NodeTransport

  beforeEach(() => {
    vi.useFakeTimers()
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
    vi.useRealTimers()
  })

  describe('node creation and configuration', () => {
    it('creates a node with explicit nodeId', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'explicit-id',
        }),
      )

      expect(nodeA.nodeId).toBe('explicit-id')
    })

    it('auto-generates nodeId when not provided', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
        }),
      )

      expect(nodeA.nodeId).toBeTruthy()
      expect(nodeA.nodeId.length).toBeGreaterThan(0)
    })

    it('defaults to all three roles when roles not specified', async () => {
      nodeA = await createClusterNode({
        coordinator,
        transport: transportA,
        address: 'node-a:9200',
      })

      expect(nodeA.roles).toEqual(['data', 'coordinator', 'controller'])
    })

    it('respects custom roles', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          roles: ['data'],
        }),
      )

      expect(nodeA.roles).toEqual(['data'])
    })

    it('rejects empty address', async () => {
      await expect(
        createClusterNode(
          makeConfig({
            coordinator,
            transport: transportA,
            address: '',
          }),
        ),
      ).rejects.toThrow('address must not be empty')
    })

    it('rejects empty roles array', async () => {
      await expect(
        createClusterNode(
          makeConfig({
            coordinator,
            transport: transportA,
            address: 'node-a:9200',
            roles: [],
          }),
        ),
      ).rejects.toThrow('at least one role')
    })

    it('rejects invalid capacity values', async () => {
      await expect(
        createClusterNode(
          makeConfig({
            coordinator,
            transport: transportA,
            address: 'node-a:9200',
            capacity: { memoryBytes: -1, cpuCores: 4, diskBytes: null },
          }),
        ),
      ).rejects.toThrow('memoryBytes')
    })
  })

  describe('start and cluster joining', () => {
    it('joins the cluster on start and registers with coordinator', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      const nodes = await coordinator.listNodes()
      const found = nodes.find(n => n.nodeId === 'node-a')
      expect(found).toBeDefined()
      expect(found?.address).toBe('node-a:9200')
    })

    it('coordinator-only node starts without lifecycle join', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['coordinator'],
        }),
      )

      await nodeA.start()

      const info = nodeA.cluster.getNodeInfo()
      expect(info.status).toBe('stopped')
    })
  })

  describe('controller role', () => {
    it('controller becomes active when node has controller role', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['data', 'controller'],
        }),
      )

      await nodeA.start()

      expect(nodeA.cluster.isControllerActive()).toBe(true)
    })

    it('node without controller role reports controller inactive', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['data'],
        }),
      )

      await nodeA.start()

      expect(nodeA.cluster.isControllerActive()).toBe(false)
    })
  })

  describe('createIndex', () => {
    it('writes index metadata and schema to coordinator', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      await nodeA.createIndex('products', {
        schema: { title: 'string', price: 'number' },
      })

      const schema = await coordinator.getSchema('products')
      expect(schema).toEqual({ title: 'string', price: 'number' })

      const rawMeta = await coordinator.get('_narsil/index/products/config')
      expect(rawMeta).not.toBeNull()
    })

    it('rejects duplicate index creation', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      await nodeA.createIndex('products', {
        schema: { title: 'string' },
      })

      await expect(nodeA.createIndex('products', { schema: { title: 'string' } })).rejects.toThrow('already exists')
    })

    it('schema appears on coordinator after createIndex on another node', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      nodeB = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportB,
          address: 'node-b:9200',
          nodeId: 'node-b',
          roles: ['data', 'coordinator'],
        }),
      )

      await nodeA.start()
      await nodeB.start()

      await nodeA.createIndex('products', {
        schema: { title: 'string', price: 'number' },
      })

      const schemaFromCoordinator = await coordinator.getSchema('products')
      expect(schemaFromCoordinator).toEqual({ title: 'string', price: 'number' })
    })
  })
})
