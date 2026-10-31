import { expect } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport, type InMemoryNetwork } from '../../../distribution/transport'
import type { NodeTransport, TransportMessage } from '../../../distribution/transport/types'
import type { NarsilConfig } from '../../../types/config'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import type { SynonymRule } from '../../../types/synonyms'
import { INDEX, LANGUAGE_NAME, SCHEMA } from './corpus'
import { hitsOf, RESULT_LIMIT, type SearchFn } from './harness'

const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 20_000
const CHUNK_PREFIX = '_narsil/synonyms/'
const CONFIG_KEY = `_narsil/index/${INDEX}/config`
export const PARTITION_COUNT = 6

export type Hook = () => Promise<void>

export interface WatchedCoordinator {
  readonly coordinator: ClusterCoordinator
  readonly liveChunks: Set<string>
  beforeChunkRead: Hook | null
  beforeChunkWrite: Hook | null
  beforeConfigSwap: Hook | null
}

function take(watched: WatchedCoordinator, name: 'beforeChunkRead' | 'beforeChunkWrite' | 'beforeConfigSwap') {
  const hook = watched[name]
  watched[name] = null
  return hook
}

export function watchCoordinator(inner: ClusterCoordinator): WatchedCoordinator {
  const overrides: Partial<ClusterCoordinator> = {
    async get(key) {
      if (key.startsWith(CHUNK_PREFIX)) await take(watched, 'beforeChunkRead')?.()
      return inner.get(key)
    },
    async compareAndSet(key, expected, value) {
      if (key.startsWith(CHUNK_PREFIX)) await take(watched, 'beforeChunkWrite')?.()
      if (key === CONFIG_KEY && expected !== null && expected.byteLength > 0) {
        await take(watched, 'beforeConfigSwap')?.()
      }
      const stored = await inner.compareAndSet(key, expected, value)
      if (stored && key.startsWith(CHUNK_PREFIX)) watched.liveChunks.add(key)
      return stored
    },
    async delete(key) {
      await inner.delete(key)
      watched.liveChunks.delete(key)
    },
  }
  const coordinator = new Proxy(inner, {
    get(target, property, receiver) {
      if (typeof property === 'string' && property in overrides) {
        return overrides[property as keyof ClusterCoordinator]
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const watched: WatchedCoordinator = {
    coordinator,
    liveChunks: new Set(),
    beforeChunkRead: null,
    beforeChunkWrite: null,
    beforeConfigSwap: null,
  }
  return watched
}

async function pollUntil(predicate: () => Promise<boolean>, what: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`${what} never happened`)
}

export interface Exchange {
  readonly from: string
  readonly target: string
  readonly request: TransportMessage
  readonly response: TransportMessage
}

function recording(nodeId: string, transport: NodeTransport, exchanges: Exchange[]): NodeTransport {
  return new Proxy(transport, {
    get(target, property, receiver) {
      if (property === 'send') {
        return async (to: string, request: TransportMessage) => {
          const response = await target.send(to, request)
          exchanges.push({ from: nodeId, target: to, request, response })
          return response
        }
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export interface GarageCluster {
  readonly watched: WatchedCoordinator
  readonly exchanges: Exchange[]
  readonly network: InMemoryNetwork
  readonly nodes: Map<string, ClusterNode>
  readonly transports: Map<string, NodeTransport>
  node(nodeId: string): ClusterNode
  startNode(
    nodeId: string,
    roles: Array<'data' | 'coordinator' | 'controller'>,
    engine?: NarsilConfig,
    coordinator?: ClusterCoordinator,
  ): Promise<void>
  stopNode(nodeId: string): Promise<void>
  shutdown(): Promise<void>
}

export async function startGarageCluster(nodeIds: readonly string[]): Promise<GarageCluster> {
  const watched = watchCoordinator(createInMemoryCoordinator())
  const network = createInMemoryNetwork()
  const nodes = new Map<string, ClusterNode>()
  const transports = new Map<string, NodeTransport>()
  const exchanges: Exchange[] = []
  const cluster: GarageCluster = {
    watched,
    exchanges,
    network,
    nodes,
    transports,
    node(nodeId) {
      const found = nodes.get(nodeId)
      if (found === undefined) throw new Error(`no node ${nodeId}`)
      return found
    },
    async startNode(nodeId, roles, engine, coordinator) {
      const transport = createInMemoryTransport(nodeId, network)
      const node = await createClusterNode({
        coordinator: coordinator ?? watched.coordinator,
        transport: recording(nodeId, transport, exchanges),
        address: `${nodeId}:9200`,
        nodeId,
        roles,
        engine: { workers: { enabled: false }, ...engine },
      })
      await node.start()
      nodes.set(nodeId, node)
      transports.set(nodeId, transport)
    },
    async stopNode(nodeId) {
      await nodes.get(nodeId)?.shutdown()
      await transports.get(nodeId)?.shutdown()
      nodes.delete(nodeId)
      transports.delete(nodeId)
    },
    async shutdown() {
      for (const nodeId of [...nodes.keys()]) await cluster.stopNode(nodeId)
      await watched.coordinator.shutdown()
    },
  }
  for (const [at, nodeId] of nodeIds.entries()) {
    await cluster.startNode(nodeId, at === 0 ? ['data', 'coordinator', 'controller'] : ['data', 'coordinator'])
  }
  await pollUntil(
    async () =>
      (await watched.coordinator.listNodes()).filter(node => node.roles.includes('data')).length === nodeIds.length,
    'every data node registering',
  )
  return cluster
}

export async function waitForPrimaries(cluster: GarageCluster, holders: number): Promise<void> {
  await pollUntil(async () => {
    const table = await cluster.watched.coordinator.getAllocation(INDEX)
    if (table === null || table.assignments.size === 0) return false
    const primaries = new Set<string>()
    for (const assignment of table.assignments.values()) {
      if (assignment.state !== 'ACTIVE' || assignment.primary === null) return false
      primaries.add(assignment.primary)
    }
    return primaries.size === holders
  }, `${holders} nodes holding a primary of ${INDEX}`)
}

export async function createClusterGarage(
  cluster: GarageCluster,
  nodeId: string,
  documents: AnyDocument[],
  synonyms: SynonymRule[],
  holders = cluster.nodes.size,
): Promise<void> {
  const node = cluster.node(nodeId)
  await node.createIndex(
    INDEX,
    { schema: SCHEMA, language: LANGUAGE_NAME, synonyms },
    { partitionCount: PARTITION_COUNT, replicationFactor: 0 },
  )
  await waitForPrimaries(cluster, holders)
  const inserted = await node.insertBatch(INDEX, documents)
  expect(inserted.failed).toEqual([])
}

export function dfsSearchOver(node: ClusterNode): SearchFn {
  return async query =>
    hitsOf(await node.query(INDEX, { ...query, scoring: 'dfs', limit: RESULT_LIMIT } as QueryParams))
}
