import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../client'
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

interface Sample {
  name: string
  labels: Record<string, string>
  value: number
}

function parsePrometheus(text: string): Sample[] {
  const samples: Sample[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? (\S+)$/.exec(line)
    if (match === null) throw new Error(`not a Prometheus sample line: ${line}`)
    const labels: Record<string, string> = {}
    for (const pair of (match[3] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      labels[pair[1] ?? ''] = (pair[2] ?? '').replace(/\\(.)/g, (_, escaped: string) =>
        escaped === 'n' ? '\n' : escaped,
      )
    }
    samples.push({ name: match[1] ?? '', labels, value: Number(match[4]) })
  }
  return samples
}

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

  it('reports the commit point, the in-sync replicas, the lag of each replica, and the coordinator timings', async () => {
    const router = nodes.get('harbour-office')?.node
    await router?.createIndex(
      'manifests',
      { schema: { title: 'string' } },
      { partitionCount: PARTITION_COUNT, replicationFactor: 1 },
    )
    await waitFor(async () => {
      const table = await coordinator.getAllocation('manifests')
      return (
        table !== null &&
        [...table.assignments.values()].every(
          entry => entry.state === 'ACTIVE' && entry.replicas.every(replica => entry.inSyncSet.includes(replica)),
        )
      )
    })

    const client = createNarsilClient({ url: urlOf('harbour-office', ''), headers: { 'x-api-key': API_KEY } })
    const written = 57
    const documents = Array.from({ length: written }, (_, index) => ({
      id: `manifest-${index}`,
      title: `cargo ${index}`,
    }))
    expect((await client.insertBatch('manifests', documents)).failed).toEqual([])
    await client.remove('manifests', 'manifest-0')

    const refused = await fetch(urlOf('harbour-office', '/metrics'))
    expect(refused.status).toBe(401)

    const scraped = new Map<string, Sample[]>()
    for (const nodeId of nodes.keys()) {
      const response = await fetch(urlOf(nodeId, '/metrics'), { headers: { 'x-api-key': API_KEY } })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/plain')
      scraped.set(nodeId, parsePrometheus(await response.text()))
    }

    const fromRouter = scraped.get('harbour-office') ?? []
    expect(fromRouter.filter(sample => sample.name === 'narsil_commit_point')).toEqual([])
    const floors = fromRouter.filter(sample => sample.name === 'narsil_commit_point_floor')
    const table = await coordinator.getAllocation('manifests')
    expect(new Map(floors.map(sample => [Number(sample.labels.partition), sample.value]))).toEqual(
      new Map([...(table?.assignments ?? new Map()).entries()].map(([id, entry]) => [id, entry.commitPoint])),
    )
    const liveCommitPoints = DATA_NODES.flatMap(nodeId =>
      (scraped.get(nodeId) ?? []).filter(sample => sample.name === 'narsil_commit_point'),
    )
    expect(liveCommitPoints.map(sample => sample.labels.partition).sort()).toEqual(['0', '1', '2', '3'])
    expect(liveCommitPoints.reduce((sum, sample) => sum + sample.value, 0)).toBe(written + 1)
    const inSync = fromRouter.filter(sample => sample.name === 'narsil_in_sync_replicas')
    expect(inSync.map(sample => sample.value)).toEqual(Array.from({ length: PARTITION_COUNT }, () => 1))
    expect(fromRouter.filter(sample => sample.name === 'narsil_replication_lag')).toEqual([])

    const lagLines = DATA_NODES.flatMap(nodeId =>
      (scraped.get(nodeId) ?? []).filter(sample => sample.name === 'narsil_replication_lag'),
    )
    expect(lagLines.map(sample => sample.labels.partition).sort()).toEqual(['0', '1', '2', '3'])
    for (const sample of lagLines) {
      expect(sample.labels.index).toBe('manifests')
      expect(DATA_NODES).toContain(sample.labels.replica)
      expect(sample.value).toBe(0)
    }

    for (const samples of scraped.values()) {
      const operations = new Set(
        samples
          .filter(sample => sample.name === 'narsil_coordinator_request_seconds_count')
          .map(s => s.labels.operation),
      )
      expect(operations.has('getAllocation') || operations.has('listNodes')).toBe(true)
      for (const operation of operations) {
        const buckets = samples.filter(
          sample =>
            sample.name === 'narsil_coordinator_request_seconds_bucket' && sample.labels.operation === operation,
        )
        const counts = buckets.map(sample => sample.value)
        expect(counts).toEqual([...counts].sort((left, right) => left - right))
        const count = samples.find(
          sample => sample.name === 'narsil_coordinator_request_seconds_count' && sample.labels.operation === operation,
        )?.value
        expect(buckets.find(sample => sample.labels.le === '+Inf')?.value).toBe(count)
      }
    }
  }, 60_000)
})
