import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../../distribution/cluster-node'
import type { ClusterNode } from '../../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../distribution/transport'
import type { NodeTransport } from '../../../../distribution/transport/types'
import { makeConfig } from './fixtures'

describe('createClusterNode (single node insert/query/cluster namespace/shutdown)', () => {
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

  describe('cluster namespace', () => {
    it('getAllocation returns null when no allocation exists', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      const allocation = await nodeA.cluster.getAllocation('nonexistent')
      expect(allocation).toBeNull()
    })

    it('getNodeInfo returns correct node information', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['data', 'coordinator'],
        }),
      )

      const info = nodeA.cluster.getNodeInfo()
      expect(info.nodeId).toBe('node-a')
      expect(info.roles).toEqual(['data', 'coordinator'])
      expect(info.status).toBe('stopped')
    })
  })

  describe('shutdown', () => {
    it('deregisters from coordinator on shutdown', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()

      const nodesBefore = await coordinator.listNodes()
      expect(nodesBefore.find(n => n.nodeId === 'node-a')).toBeDefined()

      await nodeA.shutdown()
      nodeA = undefined

      const nodesAfter = await coordinator.listNodes()
      expect(nodesAfter.find(n => n.nodeId === 'node-a')).toBeUndefined()
    })

    it('stops controller on shutdown', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
          roles: ['controller'],
        }),
      )

      await nodeA.start()
      expect(nodeA.cluster.isControllerActive()).toBe(true)

      await nodeA.shutdown()

      expect(nodeA.cluster.isControllerActive()).toBe(false)
      nodeA = undefined
    })

    it('is idempotent', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()
      await nodeA.shutdown()
      await nodeA.shutdown()
      await nodeA.shutdown()
      nodeA = undefined
    })

    it('rejects operations after shutdown', async () => {
      nodeA = await createClusterNode(
        makeConfig({
          coordinator,
          transport: transportA,
          address: 'node-a:9200',
          nodeId: 'node-a',
        }),
      )

      await nodeA.start()
      await nodeA.createIndex('products', { schema: { title: 'string' } })
      await nodeA.shutdown()

      await expect(nodeA.insert('products', { title: 'test' })).rejects.toThrow('shut down')

      await expect(nodeA.query('products', { term: 'test' })).rejects.toThrow('shut down')

      await expect(nodeA.createIndex('other', { schema: { x: 'string' } })).rejects.toThrow('shut down')

      nodeA = undefined
    })
  })
})
