import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClusterNode } from '../../../../distribution/cluster-node'
import type { ClusterNode } from '../../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../distribution/transport'
import type { NodeTransport } from '../../../../distribution/transport/types'
import { makeConfig } from './fixtures'

describe('createClusterNode (createIndex validation of partitionCount and replicationFactor)', () => {
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

  it('rejects partitionCount of 0', async () => {
    nodeA = await createClusterNode(
      makeConfig({
        coordinator,
        transport: transportA,
        address: 'node-a:9200',
        nodeId: 'node-a',
      }),
    )

    await nodeA.start()

    await expect(nodeA.createIndex('products', { schema: { title: 'string' } }, { partitionCount: 0 })).rejects.toThrow(
      'partitionCount must be an integer between 1 and 65536',
    )
  })

  it('rejects negative partitionCount', async () => {
    nodeA = await createClusterNode(
      makeConfig({
        coordinator,
        transport: transportA,
        address: 'node-a:9200',
        nodeId: 'node-a',
      }),
    )

    await nodeA.start()

    await expect(
      nodeA.createIndex('products', { schema: { title: 'string' } }, { partitionCount: -1 }),
    ).rejects.toThrow('partitionCount must be an integer between 1 and 65536')
  })

  it('rejects partitionCount exceeding 65536', async () => {
    nodeA = await createClusterNode(
      makeConfig({
        coordinator,
        transport: transportA,
        address: 'node-a:9200',
        nodeId: 'node-a',
      }),
    )

    await nodeA.start()

    await expect(
      nodeA.createIndex('products', { schema: { title: 'string' } }, { partitionCount: 100_000 }),
    ).rejects.toThrow('partitionCount must be an integer between 1 and 65536')
  })

  it('rejects negative replicationFactor', async () => {
    nodeA = await createClusterNode(
      makeConfig({
        coordinator,
        transport: transportA,
        address: 'node-a:9200',
        nodeId: 'node-a',
      }),
    )

    await nodeA.start()

    await expect(
      nodeA.createIndex('products', { schema: { title: 'string' } }, { replicationFactor: -1 }),
    ).rejects.toThrow('replicationFactor must be an integer between 0 and 255')
  })

  it('rejects replicationFactor exceeding 255', async () => {
    nodeA = await createClusterNode(
      makeConfig({
        coordinator,
        transport: transportA,
        address: 'node-a:9200',
        nodeId: 'node-a',
      }),
    )

    await nodeA.start()

    await expect(
      nodeA.createIndex('products', { schema: { title: 'string' } }, { replicationFactor: 300 }),
    ).rejects.toThrow('replicationFactor must be an integer between 0 and 255')
  })

  it('rejects non-integer partitionCount', async () => {
    nodeA = await createClusterNode(
      makeConfig({
        coordinator,
        transport: transportA,
        address: 'node-a:9200',
        nodeId: 'node-a',
      }),
    )

    await nodeA.start()

    await expect(
      nodeA.createIndex('products', { schema: { title: 'string' } }, { partitionCount: 2.5 }),
    ).rejects.toThrow('partitionCount must be an integer between 1 and 65536')
  })

  it('accepts valid edge values (partitionCount=1, replicationFactor=0)', async () => {
    nodeA = await createClusterNode(
      makeConfig({
        coordinator,
        transport: transportA,
        address: 'node-a:9200',
        nodeId: 'node-a',
      }),
    )

    await nodeA.start()

    await nodeA.createIndex('products', { schema: { title: 'string' } }, { partitionCount: 1, replicationFactor: 0 })

    const schema = await coordinator.getSchema('products')
    expect(schema).toEqual({ title: 'string' })
  })
})
