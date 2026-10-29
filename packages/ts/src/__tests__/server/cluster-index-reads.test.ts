import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../client'
import { createClusterNode } from '../../distribution/cluster-node'
import { clusterNodeEngine } from '../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../distribution/coordinator'
import type { ClusterCoordinator } from '../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../distribution/transport/in-memory'
import { NarsilError } from '../../errors'
import { createServer, type NarsilServer } from '../../server'

const PARTITION_COUNT = 4
const ALLOCATION_WAIT_MS = 20_000

async function waitForActive(coordinator: ClusterCoordinator, indexName: string): Promise<void> {
  const deadline = Date.now() + ALLOCATION_WAIT_MS
  while (Date.now() < deadline) {
    const table = await coordinator.getAllocation(indexName)
    if (table !== null && [...table.assignments.values()].every(entry => entry.state === 'ACTIVE')) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`index '${indexName}' never became active`)
}

describe('a cluster served over HTTP answers the index list and the index figures', () => {
  let coordinator: ClusterCoordinator
  const nodes: ClusterNode[] = []
  let server: NarsilServer
  let client: NarsilClient

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    for (const nodeId of ['tide-a', 'tide-b']) {
      const node = await createClusterNode({
        coordinator,
        transport: createInMemoryTransport(nodeId, network),
        address: `${nodeId}:9200`,
        nodeId,
        roles: ['data'],
      })
      nodes.push(node)
      await node.start()
    }
    const router = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('tide-office', network),
      address: 'tide-office:9200',
      nodeId: 'tide-office',
      roles: ['coordinator', 'controller'],
    })
    nodes.push(router)
    await router.start()
    server = createServer(
      clusterNodeEngine(router, { createIndex: { partitionCount: PARTITION_COUNT, replicationFactor: 1 } }),
      { host: '127.0.0.1', port: 0 },
    )
    await server.listen()
    client = createNarsilClient({ url: `http://127.0.0.1:${server.listeningPort}` })
  })

  afterEach(async () => {
    await server.close()
    for (const node of nodes.splice(0).reverse()) await node.shutdown().catch(() => {})
    await coordinator.shutdown()
  })

  it('counts every document across the nodes that hold the partitions, from a node that holds none', async () => {
    const oracle = new Map([
      ['tides', 37],
      ['currents', 11],
    ])
    for (const [indexName, total] of oracle) {
      await client.createIndex(indexName, { schema: { title: 'string' }, language: 'english' })
      await waitForActive(coordinator, indexName)
      const documents = Array.from({ length: total }, (_, index) => ({
        id: `${indexName}-${index}`,
        title: `ebb ${index}`,
      }))
      expect((await client.insertBatch(indexName, documents)).failed).toEqual([])
    }

    const listed = await client.listIndexes()
    expect(new Map(listed.map(index => [index.name, index.documentCount]))).toEqual(oracle)
    for (const index of listed) {
      expect(index.partitionCount).toBe(PARTITION_COUNT)
      expect(index.language).toBe('english')
    }

    for (const [indexName, total] of oracle) {
      const stats = await client.getStats(indexName)
      expect(stats.documentCount).toBe(total)
      expect(stats.partitionCount).toBe(PARTITION_COUNT)
      const partitions = await client.getPartitionStats(indexName)
      expect(partitions.map(partition => partition.partitionId)).toEqual([0, 1, 2, 3])
      expect(partitions.reduce((sum, partition) => sum + partition.documentCount, 0)).toBe(total)
    }
  }, 60_000)

  it('answers INDEX_NOT_FOUND for an index the cluster never held', async () => {
    const stats = await client.getStats('sargasso').catch((err: unknown) => err)
    expect(stats).toBeInstanceOf(NarsilError)
    expect((stats as NarsilError).code).toBe('INDEX_NOT_FOUND')
    const partitions = await client.getPartitionStats('sargasso').catch((err: unknown) => err)
    expect((partitions as NarsilError).code).toBe('INDEX_NOT_FOUND')
    expect(await client.listIndexes()).toEqual([])
  })
})
