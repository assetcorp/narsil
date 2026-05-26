import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClusterNode } from '../../../../distribution/cluster-node'
import type { ClusterNode } from '../../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type { ClusterCoordinator, PartitionAssignment } from '../../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../distribution/transport'
import type { NodeTransport } from '../../../../distribution/transport/types'
import { makeAllocationTable, makeAssignment, makeConfig } from './fixtures'

describe('createClusterNode message handler', () => {
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

  it('handles replication.forward messages and inserts documents', async () => {
    nodeB = await createClusterNode(
      makeConfig({
        coordinator,
        transport: transportB,
        address: 'node-b:9200',
        nodeId: 'node-b',
        roles: ['data'],
      }),
    )

    await nodeB.start()
    await nodeB.createIndex('products', { schema: { title: 'string' } })

    const assignments = new Map<number, PartitionAssignment>()
    assignments.set(0, makeAssignment({ primary: 'node-b', state: 'ACTIVE' }))
    await coordinator.putAllocation('products', makeAllocationTable('products', assignments))

    const { encode } = await import('@msgpack/msgpack')
    const { createForwardMessage } = await import('../../../../distribution/replication/codec')
    const { decode } = await import('@msgpack/msgpack')

    const forwardMsg = createForwardMessage(
      {
        indexName: 'products',
        documentId: 'msg-handler-doc',
        operation: 'insert',
        document: encode({ title: 'Handler Test' }),
        updateFields: null,
      },
      'node-a',
    )

    const response = await transportA.send('node-b', forwardMsg)
    const result = decode(response.payload) as Record<string, unknown>

    expect(result.documentId).toBe('msg-handler-doc')
    expect(result.success).toBe(true)

    const queryResult = await nodeB.query('products', { term: 'Handler' })
    expect(queryResult.count).toBe(1)
  })

  it('handles query.search messages and returns scored results', async () => {
    nodeB = await createClusterNode(
      makeConfig({
        coordinator,
        transport: transportB,
        address: 'node-b:9200',
        nodeId: 'node-b',
        roles: ['data'],
      }),
    )

    await nodeB.start()
    await nodeB.createIndex('products', { schema: { title: 'string' } })
    await nodeB.insert('products', { title: 'Search Target' }, 'search-doc')

    const { decode } = await import('@msgpack/msgpack')
    const { createSearchMessage } = await import('../../../../distribution/query/codec')

    const searchMsg = createSearchMessage(
      {
        indexName: 'products',
        partitionIds: [0],
        params: {
          term: 'Search',
          filters: null,
          sort: null,
          group: null,
          facets: null,
          facetSize: null,
          limit: 10,
          offset: 0,
          searchAfter: null,
          fields: null,
          boost: null,
          tolerance: null,
          threshold: null,
          scoring: 'local',
          vector: null,
          hybrid: null,
        },
        globalStats: null,
        facetShardSize: null,
      },
      'node-a',
    )

    const response = await transportA.send('node-b', searchMsg)
    const result = decode(response.payload) as { results: Array<{ totalHits: number }> }

    expect(result.results).toHaveLength(1)
    expect(result.results[0].totalHits).toBe(1)
  })

  it('write forwarding timeout produces a transport error', async () => {
    vi.useRealTimers()

    const fastNetwork = createInMemoryNetwork()
    const fastTransportA = createInMemoryTransport('fast-a', fastNetwork, { requestTimeout: 50 })
    createInMemoryTransport('fast-b', fastNetwork, { requestTimeout: 50 })

    const fastNodeA = await createClusterNode(
      makeConfig({
        coordinator,
        transport: fastTransportA,
        address: 'fast-a:9200',
        nodeId: 'fast-a',
        roles: ['data', 'coordinator'],
      }),
    )

    await fastNodeA.start()
    await fastNodeA.createIndex('timeout-idx', { schema: { title: 'string' } })

    const assignments = new Map<number, PartitionAssignment>()
    for (let i = 0; i < 5; i++) {
      assignments.set(i, makeAssignment({ primary: 'fast-b', state: 'ACTIVE' }))
    }
    await coordinator.putAllocation('timeout-idx', makeAllocationTable('timeout-idx', assignments))

    await expect(fastNodeA.insert('timeout-idx', { title: 'Will Timeout' }, 'timeout-doc')).rejects.toThrow(
      /timed out/i,
    )

    await fastNodeA.shutdown()
    await fastTransportA.shutdown()
    vi.useFakeTimers()
  })
})
