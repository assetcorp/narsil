import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../distribution/cluster-node'
import { clusterNodeEngine } from '../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../distribution/coordinator'
import type { ClusterCoordinator, NodeRole } from '../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../distribution/transport/in-memory'
import type { NodeTransport } from '../../distribution/transport/types'
import { createFilesystemPersistence } from '../../persistence/filesystem'
import { createServer, type NarsilServer } from '../../server'

const API_KEY = 'tide-office'
const CONTROLLER = 'tide-office'
const DATA_NODES = ['gauge-a', 'gauge-b']
const SOURCE = 'tides'
const RESTORED = 'tides-restored'
const FIRST_PARTITION_COUNT = 2
const RESHARDED_PARTITION_COUNT = 3
const READINGS = 60
const KEY_PREFIX = 'clusters/tides'
const WAIT_MS = 30_000

interface IndexHealthBody {
  indexName: string
  status: string
  partitionCount: number
  partitionsWithoutPrimary: number
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('the condition never held')
}

function partitionsIn(text: string, family: string, indexName: string): number[] {
  const found = new Set<number>()
  const pattern = new RegExp(`^${family}\\{index="([^"]*)",partition="(\\d+)"\\} `)
  for (const line of text.split('\n')) {
    const match = pattern.exec(line)
    if (match !== null && match[1] === indexName) found.add(Number(match[2]))
  }
  return [...found].sort((left, right) => left - right)
}

function everyPartition(count: number): number[] {
  return Array.from({ length: count }, (_, partitionId) => partitionId)
}

describe('cluster health and metrics for a resharded index and a restored index', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let scratch = ''
  let storeDirectory = ''
  const nodes = new Map<string, { node: ClusterNode; transport: NodeTransport; server: NarsilServer }>()

  async function startNode(nodeId: string, roles: NodeRole[]): Promise<void> {
    const transport = createInMemoryTransport(nodeId, network)
    const node = await createClusterNode({
      coordinator,
      transport,
      address: nodeId,
      nodeId,
      roles,
      backups: { store: createFilesystemPersistence({ directory: storeDirectory }), keyPrefix: KEY_PREFIX },
      engine: { workers: { enabled: false }, durability: { directory: join(scratch, nodeId), mode: 'sync' } },
    })
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

  function controller(): ClusterNode {
    const entry = nodes.get(CONTROLLER)
    if (entry === undefined) throw new Error('the controller is not running')
    return entry.node
  }

  async function read(nodeId: string, path: string): Promise<Response> {
    const port = nodes.get(nodeId)?.server.listeningPort
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'x-api-key': API_KEY } })
    expect(response.status).toBe(200)
    return response
  }

  async function health(): Promise<{ status: string; indexes: IndexHealthBody[] }> {
    return (await (await read(CONTROLLER, '/cluster/health')).json()) as { status: string; indexes: IndexHealthBody[] }
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'narsil-health-generations-'))
    storeDirectory = await mkdtemp(join(tmpdir(), 'narsil-health-generations-store-'))
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    for (const nodeId of DATA_NODES) await startNode(nodeId, ['data'])
    await startNode(CONTROLLER, ['coordinator', 'controller'])
    const router = controller()
    await router.createIndex(
      SOURCE,
      { schema: { station: 'string', level: 'number' } },
      { partitionCount: FIRST_PARTITION_COUNT, replicationFactor: 1 },
    )
    const readings = Array.from({ length: READINGS }, (_, at) => ({
      id: `reading-${at}`,
      station: `harbour station ${at % 7}`,
      level: at,
    }))
    expect((await clusterNodeEngine(router).insertBatch(SOURCE, readings)).failed).toEqual([])
    await router.rebalance(SOURCE, RESHARDED_PARTITION_COUNT)
    await router.cluster.createBackup(SOURCE, 'after-reshard')
    await router.cluster.restoreBackup('after-reshard', { indexName: RESTORED })
  }, 120_000)

  afterAll(async () => {
    for (const { node, transport, server } of [...nodes.values()].reverse()) {
      await server.close().catch(() => undefined)
      await node.shutdown().catch(() => undefined)
      await transport.shutdown().catch(() => undefined)
    }
    await coordinator.shutdown()
    await rm(scratch, { recursive: true, force: true })
    await rm(storeDirectory, { recursive: true, force: true })
  })

  it('reports both indexes by the state of the partitions that serve them', async () => {
    const healthy = (index: IndexHealthBody | undefined): boolean =>
      index?.status === 'green' && index.partitionsWithoutPrimary === 0
    await waitFor(async () => {
      const report = await health()
      return (
        healthy(report.indexes.find(index => index.indexName === SOURCE)) &&
        healthy(report.indexes.find(index => index.indexName === RESTORED))
      )
    })
    const report = await health()
    expect(report.status).toBe('green')
    expect(
      report.indexes.map(({ indexName, status, partitionCount, partitionsWithoutPrimary }) => ({
        indexName,
        status,
        partitionCount,
        partitionsWithoutPrimary,
      })),
    ).toEqual([
      { indexName: SOURCE, status: 'green', partitionCount: RESHARDED_PARTITION_COUNT, partitionsWithoutPrimary: 0 },
      { indexName: RESTORED, status: 'green', partitionCount: RESHARDED_PARTITION_COUNT, partitionsWithoutPrimary: 0 },
    ])
  }, 60_000)

  it('lists every partition of both indexes at /metrics, with the commit point of each from the node that leads it', async () => {
    const floors = await (await read(CONTROLLER, '/metrics')).text()
    for (const indexName of [SOURCE, RESTORED]) {
      expect(partitionsIn(floors, 'narsil_commit_point_floor', indexName), indexName).toEqual(
        everyPartition(RESHARDED_PARTITION_COUNT),
      )
    }
    const led = await Promise.all(DATA_NODES.map(async nodeId => (await read(nodeId, '/metrics')).text()))
    for (const indexName of [SOURCE, RESTORED]) {
      const commitPoints = new Set(led.flatMap(text => partitionsIn(text, 'narsil_commit_point', indexName)))
      expect(
        [...commitPoints].sort((left, right) => left - right),
        indexName,
      ).toEqual(everyPartition(RESHARDED_PARTITION_COUNT))
    }
  })
})
