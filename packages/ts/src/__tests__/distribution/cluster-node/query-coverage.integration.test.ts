import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import { ErrorCodes, NarsilError } from '../../../errors'

const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 15_000
const PARTITION_COUNT = 4
const DOCUMENT_TOTAL = 24
const LOST_NODE = 'holder-2'
const SHORT_PARTITION_TIMEOUT_MS = 50
const TIMEOUT_ALLOWANCE_MS = 2_000

async function pollUntil(predicate: () => Promise<boolean> | boolean): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

function shopDocuments(): Array<Record<string, unknown>> {
  const documents: Array<Record<string, unknown>> = []
  for (let index = 0; index < DOCUMENT_TOTAL; index += 1) {
    documents.push({ id: `item-${index}`, title: `portable grinder ${index}`, price: index })
  }
  return documents
}

describe('a cluster search reporting the partitions it lost', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodes: ClusterNode[]
  let transports: NodeTransport[]
  let router: ClusterNode
  let strictRouter: ClusterNode
  let impatientRouter: ClusterNode

  async function partitionsOn(nodeId: string): Promise<number> {
    const table = await coordinator.getAllocation('shop')
    if (table === null) throw new Error('the index has no allocation')
    let held = 0
    for (const assignment of table.assignments.values()) {
      if (assignment.primary === nodeId) held += 1
    }
    return held
  }

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    nodes = []
    transports = []

    for (const nodeId of ['holder-1', LOST_NODE]) {
      const transport = createInMemoryTransport(nodeId, network)
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

    const strictTransport = createInMemoryTransport('strict-router', network)
    transports.push(strictTransport)
    strictRouter = await createClusterNode({
      coordinator,
      transport: strictTransport,
      address: 'strict-router:9200',
      nodeId: 'strict-router',
      roles: ['coordinator'],
      query: { allowPartialResults: false },
    })
    await strictRouter.start()
    nodes.push(strictRouter)

    const impatientTransport = createInMemoryTransport('impatient-router', network)
    transports.push(impatientTransport)
    impatientRouter = await createClusterNode({
      coordinator,
      transport: impatientTransport,
      address: 'impatient-router:9200',
      nodeId: 'impatient-router',
      roles: ['coordinator'],
      query: { partitionTimeout: SHORT_PARTITION_TIMEOUT_MS },
    })
    await impatientRouter.start()
    nodes.push(impatientRouter)

    const registered = await pollUntil(async () => (await coordinator.listNodes()).length === 2)
    expect(registered).toBe(true)

    await router.createIndex(
      'shop',
      { schema: { title: 'string', price: 'number' } },
      { partitionCount: PARTITION_COUNT, replicationFactor: 0 },
    )

    const spread = await pollUntil(async () => {
      const table = await coordinator.getAllocation('shop')
      if (table === null || table.assignments.size === 0) return false
      const primaries = new Set<string>()
      for (const assignment of table.assignments.values()) {
        if (assignment.state !== 'ACTIVE' || assignment.primary === null) return false
        primaries.add(assignment.primary)
      }
      return primaries.size === 2
    })
    expect(spread).toBe(true)

    const inserted = await router.insertBatch('shop', shopDocuments())
    expect(inserted.failed).toEqual([])
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

  it('reports full coverage while every node answers', async () => {
    const result = await router.query('shop', { term: 'portable', limit: DOCUMENT_TOTAL })

    expect(result.hits).toHaveLength(DOCUMENT_TOTAL)
    expect(result.coverage).toEqual({
      totalPartitions: PARTITION_COUNT,
      queriedPartitions: PARTITION_COUNT,
      timedOutPartitions: 0,
      failedPartitions: 0,
    })
  }, 30_000)

  it('returns the hits it gathered and counts the unreachable partitions as failed', async () => {
    const lost = await partitionsOn(LOST_NODE)
    expect(lost).toBeGreaterThan(0)
    network.unregister(LOST_NODE)

    const result = await router.query('shop', { term: 'portable', limit: DOCUMENT_TOTAL })

    expect(result.coverage).toEqual({
      totalPartitions: PARTITION_COUNT,
      queriedPartitions: PARTITION_COUNT - lost,
      timedOutPartitions: 0,
      failedPartitions: lost,
    })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.length).toBeLessThan(DOCUMENT_TOTAL)
  }, 30_000)

  it('gives up on a silent node after the configured partition timeout', async () => {
    const lost = await partitionsOn(LOST_NODE)
    expect(lost).toBeGreaterThan(0)
    const silent = createInMemoryTransport(LOST_NODE, network)
    transports.push(silent)
    await silent.listen(() => undefined)

    const startedAt = Date.now()
    const result = await impatientRouter.query('shop', { term: 'portable', limit: DOCUMENT_TOTAL })
    const elapsed = Date.now() - startedAt

    expect(result.coverage).toEqual({
      totalPartitions: PARTITION_COUNT,
      queriedPartitions: PARTITION_COUNT - lost,
      timedOutPartitions: lost,
      failedPartitions: 0,
    })
    expect(elapsed).toBeLessThan(TIMEOUT_ALLOWANCE_MS)
  }, 30_000)

  it('fails the whole search on a node that refuses partial results', async () => {
    network.unregister(LOST_NODE)

    const failure = await strictRouter.query('shop', { term: 'portable', limit: DOCUMENT_TOTAL }).catch(err => err)

    expect(failure).toBeInstanceOf(NarsilError)
    expect((failure as NarsilError).code).toBe(ErrorCodes.QUERY_PARTIAL_FAILURE)
  }, 30_000)
})
