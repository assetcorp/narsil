import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'

const NODE_IDS = ['node-a', 'node-b', 'node-c']
const PARTITION_COUNT = 6
const REPLICATION_FACTOR = 1
const DOCUMENT_TOTAL = 600
const INDEX_NAME = 'listings'

function listingDocuments(): Array<Record<string, unknown>> {
  const documents: Array<Record<string, unknown>> = []
  for (let index = 0; index < DOCUMENT_TOTAL; index += 1) {
    documents.push({ id: `listing-${index}`, title: `mortgage advisor ${index}`, price: index })
  }
  return documents
}

describe('a fresh cluster serving its first index', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodes: ClusterNode[]
  let transports: NodeTransport[]

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    nodes = []
    transports = []

    for (const nodeId of NODE_IDS) {
      const transport = createInMemoryTransport(nodeId, network)
      transports.push(transport)
      const node = await createClusterNode({
        coordinator,
        transport,
        address: `${nodeId}:9200`,
        nodeId,
        roles: ['data', 'coordinator', 'controller'],
      })
      await node.start()
      nodes.push(node)
    }
  }, 30_000)

  afterEach(async () => {
    for (const node of nodes) {
      await node.shutdown()
    }
    for (const transport of transports) {
      await transport.shutdown()
    }
    await coordinator.shutdown()
  })

  it('takes a write straight after the creation and answers every read whole from every node', async () => {
    const creator = nodes[0]
    await creator.createIndex(
      INDEX_NAME,
      { schema: { title: 'string', price: 'number' } },
      { partitionCount: PARTITION_COUNT, replicationFactor: REPLICATION_FACTOR },
    )

    const inserted = await creator.insertBatch(INDEX_NAME, listingDocuments())
    expect(inserted.failed).toEqual([])
    expect(inserted.succeeded).toHaveLength(DOCUMENT_TOTAL)

    const allIds = listingDocuments().map(document => String(document.id))
    for (const node of nodes) {
      const search = await node.query(INDEX_NAME, { term: 'mortgage', limit: 10 })
      expect(search.count).toBe(DOCUMENT_TOTAL)
      expect(search.coverage).toEqual({
        totalPartitions: PARTITION_COUNT,
        queriedPartitions: PARTITION_COUNT,
        timedOutPartitions: 0,
        failedPartitions: 0,
      })

      expect(await node.countDocuments(INDEX_NAME)).toBe(DOCUMENT_TOTAL)
      expect((await node.getStats(INDEX_NAME)).documentCount).toBe(DOCUMENT_TOTAL)
      expect((await node.listDocuments(INDEX_NAME, { limit: 5 })).total).toBe(DOCUMENT_TOTAL)
      expect((await node.getMultiple(INDEX_NAME, allIds)).size).toBe(DOCUMENT_TOTAL)
    }
  }, 60_000)
})
