import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport, type InMemoryNetwork } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { createNarsil } from '../../../narsil'
import { createMemoryPersistence } from '../../../persistence/memory'
import type { Narsil } from '../../../types/engine'
import type { QueryParams } from '../../../types/search'
import { waitForActiveAllocation } from './cluster-harness'

const PARTITION_COUNT = 4
const BRAND_COUNT = 32
const SCHEMA = { title: 'string', brand: 'string', price: 'number' } as const

function bootDocuments(): Array<Record<string, unknown>> {
  const documents: Array<Record<string, unknown>> = []
  for (let brand = 0; brand < BRAND_COUNT; brand++) {
    const pairs = 1 + ((brand * 5) % 9)
    for (let copy = 0; copy < pairs; copy++) {
      const serial = documents.length
      documents.push({
        id: `boot-${serial}`,
        title: `trail boot ${serial}`,
        brand: `maker-${String(brand).padStart(2, '0')}`,
        price: (serial * 37) % 400,
      })
    }
  }
  return documents
}

describe('facet ranges and lowest-first facets across a cluster', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transports: NodeTransport[]
  let nodes: ClusterNode[]
  let router: ClusterNode
  let single: Narsil

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transports = []
    nodes = []

    for (const nodeId of ['shelf-1', 'shelf-2']) {
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

    await router.createIndex('boots', { schema: SCHEMA }, { partitionCount: PARTITION_COUNT, replicationFactor: 0 })
    const allocation = await waitForActiveAllocation(coordinator, 'boots')
    const holders = new Set([...allocation.assignments.values()].map(assignment => assignment.primary))
    expect(holders.size).toBe(2)

    single = await createNarsil({ persistence: createMemoryPersistence(), workers: { enabled: false } })
    await single.createIndex('boots', { schema: SCHEMA })

    const documents = bootDocuments()
    expect((await router.insertBatch('boots', documents)).failed).toEqual([])
    expect((await single.insertBatch('boots', documents)).failed).toEqual([])
  }, 30_000)

  afterEach(async () => {
    await single.shutdown()
    for (const node of nodes) await node.shutdown()
    for (const transport of transports) await transport.shutdown()
    await coordinator.shutdown()
  })

  async function expectSameFacets(params: QueryParams): Promise<void> {
    const clustered = await router.query('boots', params)
    const local = await single.query('boots', params)
    expect(clustered.count).toBe(local.count)
    expect(clustered.facets).toEqual(local.facets)
  }

  it('counts price ranges and the rarest brands exactly as one engine does', async () => {
    await expectSameFacets({
      term: 'trail',
      limit: 5,
      facets: {
        brand: { sort: 'asc', limit: 4 },
        price: {
          ranges: [
            { from: 0, to: 100 },
            { from: 100, to: 250 },
            { from: 250, to: 400 },
          ],
        },
      },
    })
  }, 30_000)

  it('orders and cuts price ranges lowest first, with the bound one engine reports', async () => {
    await expectSameFacets({
      term: 'trail',
      filters: { fields: { price: { lt: 300 } } },
      facets: {
        price: {
          sort: 'asc',
          limit: 2,
          ranges: [
            { from: 0, to: 50 },
            { from: 50, to: 120 },
            { from: 120, to: 200 },
            { from: 200, to: 300 },
          ],
        },
      },
    })
  }, 30_000)
})
