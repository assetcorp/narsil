import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../distribution/cluster-node'
import { clusterNodeEngine } from '../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../distribution/coordinator'
import type { ClusterCoordinator } from '../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../distribution/transport'
import type { NodeTransport } from '../../distribution/transport/types'
import type { NarsilServer } from '../../server'
import { createServer } from '../../server'
import { getJson, postJson, startTestServer } from './helpers'

const INDEX_NAME = 'products'
const PARTITION_COUNT = 2

interface ReadyBody {
  status: string
  cluster: { nodeId: string; readiness: string; isController: boolean }
}

interface TopologyBody {
  node: { nodeId: string; roles: string[]; readiness: string; isController: boolean }
  controllerNodeId: string | null
  nodes: Array<{ nodeId: string; address: string; roles: string[] }>
}

interface AllocationBody {
  indexName: string
  allocated: boolean
  version: number | null
  partitions: Array<{ partitionId: number; state: string; primary: string | null; replicas: string[] }>
}

describe('the cluster endpoints of a server serving a cluster node', () => {
  let coordinator: ClusterCoordinator
  let transport: NodeTransport
  let node: ClusterNode
  let server: NarsilServer
  let base: string

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    transport = createInMemoryTransport('node-a', network)
    node = await createClusterNode({
      coordinator,
      transport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    const engine = clusterNodeEngine(node, {
      createIndex: { partitionCount: PARTITION_COUNT, replicationFactor: 0 },
    })
    server = createServer(engine, { host: '127.0.0.1', port: 0, cluster: node.cluster })
    await server.listen()
    base = `http://127.0.0.1:${server.listeningPort}`
  })

  afterEach(async () => {
    await server.close()
    await node.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
  })

  it('answers /readyz with 503 until the node serves, then with 200 and the readiness', async () => {
    const starting = await getJson<ReadyBody>(base, '/readyz')
    expect(starting.status).toBe(503)
    expect(starting.body.status).toBe('unavailable')
    expect(starting.body.cluster.readiness).toBe('STARTING')

    await node.start()

    const serving = await getJson<ReadyBody>(base, '/readyz')
    expect(serving.status).toBe(200)
    expect(serving.body.status).toBe('ready')
    expect(serving.body.cluster).toEqual({
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
      status: 'active',
      readiness: 'SERVING',
      isController: true,
    })
  })

  it('reports the topology at /cluster', async () => {
    await node.start()

    const topology = await getJson<TopologyBody>(base, '/cluster')

    expect(topology.status).toBe(200)
    expect(topology.body.node.nodeId).toBe('node-a')
    expect(topology.body.node.readiness).toBe('SERVING')
    expect(topology.body.node.isController).toBe(true)
    expect(topology.body.controllerNodeId).toBe('node-a')
    expect(topology.body.nodes).toEqual([
      { nodeId: 'node-a', address: 'node-a:9200', roles: ['data', 'coordinator', 'controller'] },
    ])
  })

  it('reports the allocation of one index at /indexes/:name/cluster, partition by partition', async () => {
    await node.start()

    const before = await getJson<AllocationBody>(base, `/indexes/${INDEX_NAME}/cluster`)
    expect(before.status).toBe(200)
    expect(before.body).toEqual({ indexName: INDEX_NAME, allocated: false, version: null, partitions: [] })

    const created = await postJson(base, '/indexes', { name: INDEX_NAME, config: { schema: { title: 'string' } } })
    expect(created.status).toBe(201)

    const after = await getJson<AllocationBody>(base, `/indexes/${INDEX_NAME}/cluster`)
    expect(after.status).toBe(200)
    expect(after.body.allocated).toBe(true)
    expect(after.body.partitions.map(partition => partition.partitionId)).toEqual([0, 1])
    for (const partition of after.body.partitions) {
      expect(partition.state).toBe('ACTIVE')
      expect(partition.primary).toBe('node-a')
    }
  })

  it('refuses an index name the cluster would never accept with 400', async () => {
    await node.start()

    const refused = await getJson<{ error: { code: string } }>(base, '/indexes/..%2Fescaped/cluster')

    expect(refused.status).toBe(400)
  })
})

describe('the cluster endpoints of a server serving a single engine', () => {
  it('answer 501 with CLUSTER_OPERATION_UNSUPPORTED, and /readyz stays as it was', async () => {
    const single = await startTestServer()
    try {
      const topology = await getJson<{ error: { code: string } }>(single.base, '/cluster')
      expect(topology.status).toBe(501)
      expect(topology.body.error.code).toBe('CLUSTER_OPERATION_UNSUPPORTED')

      const allocation = await getJson<{ error: { code: string } }>(single.base, '/indexes/products/cluster')
      expect(allocation.status).toBe(501)
      expect(allocation.body.error.code).toBe('CLUSTER_OPERATION_UNSUPPORTED')

      const ready = await getJson<{ status: string; cluster?: unknown }>(single.base, '/readyz')
      expect(ready.status).toBe(200)
      expect(ready.body).toEqual({ status: 'ready' })
    } finally {
      await single.stop()
    }
  })
})
