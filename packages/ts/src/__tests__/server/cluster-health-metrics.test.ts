import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../distribution/cluster-node'
import { clusterNodeEngine } from '../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../distribution/coordinator'
import type { ClusterCoordinator } from '../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../distribution/transport/in-memory'
import type { NodeTransport } from '../../distribution/transport/types'
import { createServer, type NarsilServer } from '../../server'

const API_KEY = 'harbour-master'
const DATA_NODES = ['quay-a', 'quay-b']
const PARTITION_COUNT = 4
const WAIT_MS = 20_000

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the condition never held')
}

describe('cluster health and metrics over HTTP', () => {
  let coordinator: ClusterCoordinator
  const nodes = new Map<string, { node: ClusterNode; transport: NodeTransport; server: NarsilServer }>()

  async function startNode(
    nodeId: string,
    roles: Array<'data' | 'coordinator' | 'controller'>,
    network: ReturnType<typeof createInMemoryNetwork>,
  ) {
    const transport = createInMemoryTransport(nodeId, network)
    const node = await createClusterNode({ coordinator, transport, address: nodeId, nodeId, roles })
    await node.start()
    const server = createServer(clusterNodeEngine(node), {
      host: '127.0.0.1',
      port: 0,
      cluster: node.cluster,
      onRequest: ctx =>
        ctx.headers['x-api-key'] === API_KEY ? undefined : { status: 401, code: 'UNAUTHORIZED', message: 'key' },
    })
    await server.listen()
    nodes.set(nodeId, { node, transport, server })
  }

  async function stopNode(nodeId: string): Promise<void> {
    const entry = nodes.get(nodeId)
    if (entry === undefined) return
    nodes.delete(nodeId)
    await entry.server.close()
    await entry.node.shutdown()
    await entry.transport.shutdown()
  }

  function urlOf(nodeId: string, path: string): string {
    return `http://127.0.0.1:${nodes.get(nodeId)?.server.listeningPort}${path}`
  }

  async function health(nodeId: string): Promise<{ status: string; indexes: Array<Record<string, unknown>> }> {
    const response = await fetch(urlOf(nodeId, '/cluster/health'), { headers: { 'x-api-key': API_KEY } })
    expect(response.status).toBe(200)
    return (await response.json()) as { status: string; indexes: Array<Record<string, unknown>> }
  }

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    for (const nodeId of DATA_NODES) await startNode(nodeId, ['data'], network)
    await startNode('harbour-office', ['coordinator', 'controller'], network)
  })

  afterEach(async () => {
    for (const nodeId of [...nodes.keys()].reverse()) await stopNode(nodeId).catch(() => {})
    await coordinator.shutdown()
  })

  it('reports green, yellow, and red from the copies that each index can place, and answers 200 for each', async () => {
    const unauthenticated = await fetch(urlOf('harbour-office', '/cluster/health'))
    expect(unauthenticated.status).toBe(401)
    expect(await health('harbour-office')).toEqual({ status: 'green', indexes: [] })

    const router = nodes.get('harbour-office')?.node
    await router?.createIndex(
      'berths',
      { schema: { title: 'string' } },
      { partitionCount: PARTITION_COUNT, replicationFactor: 1 },
    )
    await router?.createIndex(
      'cranes',
      { schema: { title: 'string' } },
      { partitionCount: PARTITION_COUNT, replicationFactor: 2 },
    )

    await waitFor(async () => {
      const report = await health('harbour-office')
      return report.indexes.find(index => index.indexName === 'berths')?.status === 'green'
    })
    const placed = await health('harbour-office')
    expect(placed.status).toBe('yellow')
    expect(placed.indexes).toEqual([
      {
        indexName: 'berths',
        status: 'green',
        partitionCount: PARTITION_COUNT,
        replicationFactor: 1,
        partitionsWithoutPrimary: 0,
        underReplicatedPartitions: 0,
      },
      {
        indexName: 'cranes',
        status: 'yellow',
        partitionCount: PARTITION_COUNT,
        replicationFactor: 2,
        partitionsWithoutPrimary: 0,
        underReplicatedPartitions: PARTITION_COUNT,
      },
    ])

    for (const nodeId of DATA_NODES) await stopNode(nodeId)
    await waitFor(async () => (await health('harbour-office')).status === 'red')
    const lost = await health('harbour-office')
    for (const index of lost.indexes) {
      expect(index.status).toBe('red')
      expect(index.partitionsWithoutPrimary).toBe(PARTITION_COUNT)
    }
  }, 60_000)
})
