import { decode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
  QueryMessageTypes,
} from '../../../distribution/transport'
import type { NodeTransport, SearchPayload } from '../../../distribution/transport/types'
import { waitForSettledReplica } from './cluster-harness'

const PARTITION_COUNT = 8
const COPY_NODES = ['copy-a', 'copy-b']
const TRAIL_TERMS = Array.from({ length: 24 }, (_, index) => `ridge${index}`)
const REPEATED_SEARCHES = 10

interface ServedSearch {
  nodeId: string
  term: string | null
  partitionIds: number[]
}

function recordingTransport(nodeId: string, network: InMemoryNetwork, served: ServedSearch[]): NodeTransport {
  const transport = createInMemoryTransport(nodeId, network)
  return {
    ...transport,
    listen(handler) {
      return transport.listen((message, respond) => {
        if (message.type === QueryMessageTypes.SEARCH) {
          const payload = decode(message.payload) as SearchPayload
          served.push({ nodeId, term: payload.params.term, partitionIds: payload.partitionIds })
        }
        return handler(message, respond)
      })
    },
  }
}

function copiesServing(served: ServedSearch[], term: string): Map<number, Set<string>> {
  const copies = new Map<number, Set<string>>()
  for (const search of served) {
    if (search.term !== term) continue
    for (const partitionId of search.partitionIds) {
      const nodes = copies.get(partitionId) ?? new Set<string>()
      nodes.add(search.nodeId)
      copies.set(partitionId, nodes)
    }
  }
  return copies
}

describe('a cluster that holds two copies of every partition', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transports: NodeTransport[]
  let nodes: ClusterNode[]
  let router: ClusterNode
  let secondRouter: ClusterNode
  let served: ServedSearch[]

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transports = []
    nodes = []
    served = []

    for (const nodeId of COPY_NODES) {
      const transport = recordingTransport(nodeId, network, served)
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

    const routerTransport = createInMemoryTransport('router', network)
    transports.push(routerTransport)
    router = await createClusterNode({
      coordinator,
      transport: routerTransport,
      address: 'router:9200',
      nodeId: 'router',
      roles: ['coordinator', 'controller'],
    })
    await router.start()
    nodes.push(router)

    const secondTransport = createInMemoryTransport('second-router', network)
    transports.push(secondTransport)
    secondRouter = await createClusterNode({
      coordinator,
      transport: secondTransport,
      address: 'second-router:9200',
      nodeId: 'second-router',
      roles: ['coordinator'],
    })
    await secondRouter.start()
    nodes.push(secondRouter)

    await router.createIndex(
      'trails',
      { schema: { title: 'string' } },
      { partitionCount: PARTITION_COUNT, replicationFactor: 1 },
    )
    for (const nodeId of COPY_NODES) await waitForSettledReplica(coordinator, 'trails', nodeId)

    const inserted = await router.insertBatch(
      'trails',
      TRAIL_TERMS.flatMap((term, index) => [
        { id: `trail-${index}-north`, title: `${term} lantern north` },
        { id: `trail-${index}-south`, title: `${term} lantern south` },
      ]),
    )
    expect(inserted.failed).toEqual([])
  }, 30_000)

  afterEach(async () => {
    for (const node of nodes) await node.shutdown()
    for (const transport of transports) await transport.shutdown()
    await coordinator.shutdown()
  })

  it('sends a repeated search to the same copy of each partition from every coordinator', async () => {
    served.length = 0
    const answers = []
    for (let attempt = 0; attempt < REPEATED_SEARCHES; attempt++) {
      answers.push(await router.query('trails', { term: 'lantern', limit: 50 }))
      answers.push(await secondRouter.query('trails', { term: 'lantern', limit: 50 }))
    }

    const copies = copiesServing(served, 'lantern')
    expect(copies.size).toBe(PARTITION_COUNT)
    for (const [partitionId, nodeIds] of copies) {
      expect(nodeIds.size, `partition ${partitionId}`).toBe(1)
    }
    const firstPage = answers[0].hits.map(hit => hit.id)
    for (const answer of answers) expect(answer.hits.map(hit => hit.id)).toEqual(firstPage)
  }, 30_000)

  it('spreads different searches over both copies', async () => {
    served.length = 0
    for (const term of TRAIL_TERMS) await router.query('trails', { term, limit: 5 })

    const partitionsServed = new Map<string, number>()
    for (const search of served) {
      partitionsServed.set(search.nodeId, (partitionsServed.get(search.nodeId) ?? 0) + search.partitionIds.length)
    }
    const total = TRAIL_TERMS.length * PARTITION_COUNT
    for (const nodeId of COPY_NODES) {
      expect(partitionsServed.get(nodeId) ?? 0, nodeId).toBeGreaterThan(total / 4)
      expect(partitionsServed.get(nodeId) ?? 0, nodeId).toBeLessThan((total * 3) / 4)
    }
  }, 30_000)
})
