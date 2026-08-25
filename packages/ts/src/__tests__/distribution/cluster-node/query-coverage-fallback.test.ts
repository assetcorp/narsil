import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import { makeAllocationTable, makeAssignment } from '../query/routing/fixtures'

const PARTITION_COUNT = 2
const DOCUMENT_TOTAL = 12

function shopDocuments(): Array<Record<string, unknown>> {
  const documents: Array<Record<string, unknown>> = []
  for (let index = 0; index < DOCUMENT_TOTAL; index += 1) {
    documents.push({ id: `item-${index}`, title: `portable grinder ${index}`, price: index })
  }
  return documents
}

describe('a cluster search answering from the local copy alone', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transport: NodeTransport
  let node: ClusterNode

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transport = createInMemoryTransport('node-a', network)
    node = await createClusterNode({
      coordinator,
      transport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator'],
    })
    await node.start()
    await node.createIndex('shop', { schema: { title: 'string', price: 'number' } })
    const inserted = await node.insertBatch('shop', shopDocuments())
    expect(inserted.failed).toEqual([])
  }, 30_000)

  afterEach(async () => {
    await node.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
  })

  it('reports full coverage for an index the cluster has never allocated', async () => {
    expect(await coordinator.getAllocation('shop')).toBeNull()

    const result = await node.query('shop', { term: 'portable', limit: DOCUMENT_TOTAL })

    expect(result.hits).toHaveLength(DOCUMENT_TOTAL)
    expect(result.coverage.queriedPartitions).toBe(result.coverage.totalPartitions)
    expect(result.coverage.failedPartitions).toBe(0)
  }, 30_000)

  it('counts every partition as failed while no replica is active yet', async () => {
    const table = makeAllocationTable(
      [
        [0, makeAssignment({ state: 'INITIALISING' })],
        [1, makeAssignment({ state: 'INITIALISING' })],
      ],
      'shop',
    )
    expect(await coordinator.putAllocation('shop', table, null)).toBe(true)

    const result = await node.query('shop', { term: 'portable', limit: DOCUMENT_TOTAL })

    expect(result.coverage).toEqual({
      totalPartitions: PARTITION_COUNT,
      queriedPartitions: 0,
      timedOutPartitions: 0,
      failedPartitions: PARTITION_COUNT,
    })
  }, 30_000)
})
