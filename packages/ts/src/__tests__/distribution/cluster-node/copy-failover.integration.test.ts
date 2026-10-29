import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import { type NodeTransport, TransportError, TransportErrorCodes } from '../../../distribution/transport/types'
import { waitForSettledReplica } from './cluster-harness'

const INDEX_NAME = 'trails'
const PARTITION_COUNT = 8
const COPY_NODES = ['copy-a', 'copy-b']
const ROUTER_WAIT_MS = 400
const QUERY_MESSAGE_PREFIX = 'query.'

type FaultKind = 'unreachable' | 'paused'

interface FaultState {
  unreachable: Set<string>
  paused: Set<string>
}

type StoredTrail = { id: string; title: string }

const TRAILS: StoredTrail[] = Array.from({ length: 24 }, (_, index) => [
  { id: `trail-${index}-north`, title: `ridge${index} lantern north` },
  { id: `trail-${index}-south`, title: `ridge${index} lantern south` },
]).flat()

function trailsMatching(word: string): string[] {
  return TRAILS.filter(trail => trail.title.split(' ').includes(word))
    .map(trail => trail.id)
    .sort()
}

function nodeOfTarget(target: string): string {
  return target.split(':')[0]
}

function routerTransport(network: InMemoryNetwork, faults: FaultState): NodeTransport {
  const transport = createInMemoryTransport('router', network, { requestTimeout: ROUTER_WAIT_MS })
  return {
    ...transport,
    async send(target, message) {
      if (message.type.startsWith(QUERY_MESSAGE_PREFIX) && faults.unreachable.has(nodeOfTarget(target))) {
        throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, `Node '${target}' is not reachable`, { target })
      }
      return transport.send(target, message)
    },
  }
}

function copyTransport(nodeId: string, network: InMemoryNetwork, faults: FaultState): NodeTransport {
  const transport = createInMemoryTransport(nodeId, network)
  return {
    ...transport,
    listen(handler) {
      return transport.listen((message, respond) => {
        if (message.type.startsWith(QUERY_MESSAGE_PREFIX) && faults.paused.has(nodeId)) return
        return handler(message, respond)
      })
    },
  }
}

describe('a cluster with two copies of every partition, one of them failing', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transports: NodeTransport[]
  let nodes: ClusterNode[]
  let router: ClusterNode
  let faults: FaultState

  function fail(kind: FaultKind, nodeId: string): void {
    if (kind === 'unreachable') faults.unreachable.add(nodeId)
    else faults.paused.add(nodeId)
  }

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transports = []
    nodes = []
    faults = { unreachable: new Set(), paused: new Set() }

    for (const nodeId of COPY_NODES) {
      const transport = copyTransport(nodeId, network, faults)
      transports.push(transport)
      const node = await createClusterNode({
        coordinator,
        transport,
        address: `${nodeId}:9200`,
        nodeId,
        roles: ['data'],
      })
      await node.start()
      nodes.push(node)
    }

    const transport = routerTransport(network, faults)
    transports.push(transport)
    router = await createClusterNode({
      coordinator,
      transport,
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator', 'controller'],
      query: { partitionTimeout: ROUTER_WAIT_MS },
    })
    await router.start()
    nodes.push(router)

    await router.createIndex(
      INDEX_NAME,
      { schema: { title: 'string' } },
      { partitionCount: PARTITION_COUNT, replicationFactor: 1 },
    )
    for (const nodeId of COPY_NODES) await waitForSettledReplica(coordinator, INDEX_NAME, nodeId)

    const inserted = await router.insertBatch(INDEX_NAME, TRAILS)
    expect(inserted.failed).toEqual([])
  }, 30_000)

  afterEach(async () => {
    for (const node of nodes) await node.shutdown()
    for (const transport of transports) await transport.shutdown()
    await coordinator.shutdown()
  })

  it.each<FaultKind>([
    'unreachable',
    'paused',
  ])('answers every read from the other copy while one copy is %s', async kind => {
    fail(kind, 'copy-b')
    const titles = new Map(TRAILS.map(trail => [trail.id, trail.title]))

    for (const scoring of ['local', 'dfs'] as const) {
      const answer = await router.query(INDEX_NAME, { term: 'lantern', limit: 100, scoring })
      expect(answer.coverage).toEqual({
        totalPartitions: PARTITION_COUNT,
        queriedPartitions: PARTITION_COUNT,
        timedOutPartitions: 0,
        failedPartitions: 0,
      })
      expect(answer.hits.map(hit => hit.id).sort()).toEqual(trailsMatching('lantern'))
      for (const hit of answer.hits) expect(hit.document).toEqual({ id: hit.id, title: titles.get(hit.id) })
    }

    expect(await router.countDocuments(INDEX_NAME)).toBe(TRAILS.length)
    const listed = await router.listDocuments(INDEX_NAME, { limit: TRAILS.length })
    expect(listed.documents.map(entry => entry.id)).toEqual(TRAILS.map(trail => trail.id).sort())
    const read = await router.getMultiple(
      INDEX_NAME,
      TRAILS.map(trail => trail.id),
    )
    expect(new Map([...read].map(([id, document]) => [id, document.title]))).toEqual(titles)
  }, 30_000)

  it('counts each partition once as timed out or failed when every copy of it fails', async () => {
    fail('unreachable', 'copy-a')
    fail('paused', 'copy-b')

    const answer = await router.query(INDEX_NAME, { term: 'lantern', limit: 100 })

    expect(answer.hits).toEqual([])
    expect(answer.coverage.totalPartitions).toBe(PARTITION_COUNT)
    expect(answer.coverage.queriedPartitions).toBe(0)
    expect(answer.coverage.timedOutPartitions + answer.coverage.failedPartitions).toBe(PARTITION_COUNT)
  }, 30_000)
})
