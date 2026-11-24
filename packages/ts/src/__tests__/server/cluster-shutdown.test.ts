import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../distribution/cluster-node'
import { clusterNodeEngine } from '../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../distribution/coordinator'
import type { ClusterCoordinator, NodeRole } from '../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport, type InMemoryNetwork } from '../../distribution/transport'
import type { NodeTransport, RespondFn, TransportMessage } from '../../distribution/transport/types'
import type { NarsilServer } from '../../server'
import { createServer } from '../../server'
import { postJson } from './helpers'

const INDEX_NAME = 'harbour-manifests'
const PRIMARY_NODE = 'quay-keeper'
const GATEWAY_NODE = 'harbour-gateway'
const FORWARD_TYPES = new Set(['replication.forward', 'replication.forward_batch'])
const SHUTDOWN_BOUND_MS = 5_000
const ALLOCATION_WAIT_MS = 15_000
const FORWARD_ARRIVAL_WAIT_MS = 10_000
const POLL_MS = 25
const TEST_TIMEOUT_MS = 60_000

interface RefusalBody {
  error: { code: string; details?: { reason?: string } }
}

async function until(condition: () => Promise<boolean> | boolean, waitMs: number, what: string): Promise<void> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  throw new Error(`${what} within ${waitMs} ms`)
}

describe('a server fronting a cluster node that shuts down while a write waits on a silent primary', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let primary: ClusterNode
  let primaryTransport: NodeTransport
  let gateway: ClusterNode
  let gatewayTransport: NodeTransport
  let server: NarsilServer
  let base: string
  const silence = { active: false, swallowed: 0 }

  function silentWhenAsked(nodeId: string): NodeTransport {
    const inner = createInMemoryTransport(nodeId, network)
    return {
      ...inner,
      listen: handler =>
        inner.listen((message: TransportMessage, respond: RespondFn) => {
          if (silence.active && FORWARD_TYPES.has(message.type)) {
            silence.swallowed += 1
            return
          }
          return handler(message, respond)
        }),
    }
  }

  beforeEach(async () => {
    silence.active = false
    silence.swallowed = 0
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    primaryTransport = silentWhenAsked(PRIMARY_NODE)
    primary = await createClusterNode({
      coordinator,
      transport: primaryTransport,
      address: `${PRIMARY_NODE}:9200`,
      nodeId: PRIMARY_NODE,
      roles: ['data'],
      engine: { workers: { enabled: false } },
    })
    await primary.start()
    gatewayTransport = createInMemoryTransport(GATEWAY_NODE, network)
    gateway = await createClusterNode({
      coordinator,
      transport: gatewayTransport,
      address: `${GATEWAY_NODE}:9200`,
      nodeId: GATEWAY_NODE,
      roles: ['coordinator', 'controller'],
    })
    await gateway.start()
    await gateway.createIndex(INDEX_NAME, { schema: { vessel: 'string' } }, { partitionCount: 1, replicationFactor: 0 })
    await until(
      async () => {
        const assignment = (await coordinator.getAllocation(INDEX_NAME))?.assignments.get(0)
        return assignment?.state === 'ACTIVE' && assignment.primary === PRIMARY_NODE
      },
      ALLOCATION_WAIT_MS,
      `partition 0 never became ACTIVE on ${PRIMARY_NODE}`,
    )
    server = createServer(clusterNodeEngine(gateway), { host: '127.0.0.1', port: 0, cluster: gateway.cluster })
    await server.listen()
    base = `http://127.0.0.1:${server.listeningPort}`
  })

  afterEach(async () => {
    silence.active = false
    await server.shutdown().catch(() => {})
    await gateway.shutdown().catch(() => {})
    await primary.shutdown().catch(() => {})
    await gatewayTransport.shutdown()
    await primaryTransport.shutdown()
    await coordinator.shutdown()
  })

  it(
    'finishes the shutdown at once and answers the waiting write with an unknown outcome',
    async () => {
      silence.active = true
      const answer = postJson<RefusalBody>(base, `/indexes/${INDEX_NAME}/documents`, {
        document: { vessel: 'Northern Tern' },
        id: 'manifest-7',
      })
      await until(() => silence.swallowed > 0, FORWARD_ARRIVAL_WAIT_MS, 'the forwarded write never reached the primary')

      const started = performance.now()
      await server.shutdown()
      const shutdownMs = performance.now() - started

      expect(shutdownMs).toBeLessThan(SHUTDOWN_BOUND_MS)
      const refused = await answer
      expect(refused.status).toBe(503)
      expect(refused.body.error.code).toBe('REPLICATION_OUTCOME_UNKNOWN')
      expect(refused.body.error.details?.reason).toBe('forward_window_ended')
      expect(gateway.cluster.getReadiness()).toBe('LEAVING')
      silence.active = false
      expect(await primary.get(INDEX_NAME, 'manifest-7')).toBeUndefined()
    },
    TEST_TIMEOUT_MS,
  )
})

const DATA_NODES = ['quay-keeper', 'tide-keeper']
const REPLY_TYPES = new Set(['replication.entry', 'replication.entry_batch'])
const REPLICATION_TIMEOUT_MS = 1_500
const STALL_ARRIVAL_WAIT_MS = 10_000

describe('a server fronting a primary that shuts down while its local write waits on a stalled replica', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  const nodes = new Map<string, ClusterNode>()
  const transports: NodeTransport[] = []
  let server: NarsilServer | null = null
  const stall = { replica: '', active: false, held: [] as (() => Promise<void>)[] }

  function stallableTransport(nodeId: string): NodeTransport {
    const inner = createInMemoryTransport(nodeId, network, { replicationTimeout: REPLICATION_TIMEOUT_MS })
    transports.push(inner)
    return {
      ...inner,
      listen: handler =>
        inner.listen((message: TransportMessage, respond: RespondFn) => {
          if (stall.replica !== nodeId || !REPLY_TYPES.has(message.type)) return handler(message, respond)
          return handler(message, async reply => {
            if (stall.active) stall.held.push(() => respond(reply))
            else await respond(reply)
          })
        }),
    }
  }

  async function startNode(nodeId: string, roles: NodeRole[]): Promise<ClusterNode> {
    const node = await createClusterNode({
      coordinator,
      transport: stallableTransport(nodeId),
      address: `${nodeId}:9200`,
      nodeId,
      roles,
      ...(roles.includes('data') ? { engine: { workers: { enabled: false } } } : {}),
    })
    nodes.set(nodeId, node)
    await node.start()
    return node
  }

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    stall.replica = ''
    stall.active = false
    stall.held = []
    for (const nodeId of DATA_NODES) await startNode(nodeId, ['data'])
    const gateway = await startNode(GATEWAY_NODE, ['coordinator', 'controller'])
    await gateway.createIndex(INDEX_NAME, { schema: { vessel: 'string' } }, { partitionCount: 1, replicationFactor: 1 })
  })

  afterEach(async () => {
    stall.active = false
    for (const release of stall.held.splice(0)) await release().catch(() => {})
    await server?.shutdown().catch(() => {})
    server = null
    for (const node of nodes.values()) await node.shutdown().catch(() => {})
    nodes.clear()
    for (const transport of transports.splice(0)) await transport.shutdown()
    await coordinator.shutdown()
  })

  it(
    'acknowledges the write before the server shuts the engine down',
    async () => {
      let primaryNodeId = ''
      await until(
        async () => {
          const assignment = (await coordinator.getAllocation(INDEX_NAME))?.assignments.get(0)
          const replica = assignment?.replicas[0]
          if (assignment?.state !== 'ACTIVE' || assignment.primary === null || replica === undefined) return false
          if (!assignment.inSyncSet.includes(replica)) return false
          primaryNodeId = assignment.primary
          stall.replica = replica
          return true
        },
        ALLOCATION_WAIT_MS,
        'partition 0 never became ACTIVE with an in-sync replica',
      )
      const primary = nodes.get(primaryNodeId)
      if (primary === undefined) throw new Error(`no running node is called ${primaryNodeId}`)
      const fronting = createServer(clusterNodeEngine(primary), {
        host: '127.0.0.1',
        port: 0,
        cluster: primary.cluster,
      })
      server = fronting
      await fronting.listen()

      stall.active = true
      const answer = postJson<{ id: string }>(
        `http://127.0.0.1:${fronting.listeningPort}`,
        `/indexes/${INDEX_NAME}/documents`,
        {
          document: { vessel: 'Southern Petrel' },
          id: 'manifest-11',
        },
      )
      await until(() => stall.held.length > 0, STALL_ARRIVAL_WAIT_MS, 'the replica never received the write')

      const started = performance.now()
      await fronting.shutdown()
      const shutdownMs = performance.now() - started

      expect(shutdownMs).toBeLessThan(SHUTDOWN_BOUND_MS)
      const acknowledged = await answer
      expect(acknowledged.status).toBe(201)
      expect(acknowledged.body.id).toBe('manifest-11')
    },
    TEST_TIMEOUT_MS,
  )
})
