import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { NarsilError } from '../../../errors'

const REJECTED_CONFIG = { schema: { title: 'string' as const }, bm25: { k1: -1 } }

describe('a cluster index creation the local engine refuses', () => {
  let coordinator: ClusterCoordinator
  let transport: NodeTransport
  let node: ClusterNode

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    transport = createInMemoryTransport('node-a', createInMemoryNetwork())
    node = await createClusterNode({
      coordinator,
      transport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await node.start()
  })

  afterEach(async () => {
    await node.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
  })

  it('raises the refusal the engine made', async () => {
    await expect(node.createIndex('products', REJECTED_CONFIG)).rejects.toThrow(NarsilError)
  })

  it('leaves no schema behind for the controller to allocate against', async () => {
    await expect(node.createIndex('products', REJECTED_CONFIG)).rejects.toThrow()

    expect(await coordinator.getSchema('products')).toBeNull()
    expect(await coordinator.listSchemas()).not.toContain('products')
  })

  it('leaves no metadata behind, so the name is free again', async () => {
    await expect(node.createIndex('products', REJECTED_CONFIG)).rejects.toThrow()

    await node.createIndex('products', { schema: { title: 'string' } })

    expect(await coordinator.getSchema('products')).not.toBeNull()
  })

  it('takes back the local copy where publishing the schema failed', async () => {
    const publishFailure = new Error('the coordinator refused the schema')
    const failing: ClusterCoordinator = {
      ...coordinator,
      putSchema: () => Promise.reject(publishFailure),
    }
    const isolated = await createClusterNode({
      coordinator: failing,
      transport: createInMemoryTransport('node-b', createInMemoryNetwork()),
      address: 'node-b:9200',
      nodeId: 'node-b',
      roles: ['data'],
    })
    await isolated.start()

    await expect(isolated.createIndex('products', { schema: { title: 'string' } })).rejects.toThrow(publishFailure)

    await expect(isolated.countDocuments('products')).rejects.toMatchObject({ code: 'INDEX_NOT_FOUND' })
    await isolated.shutdown()
  })
})
