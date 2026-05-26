import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AllocationTable } from '../../../../distribution/coordinator/types'
import { decodePayload } from '../../../../distribution/query/codec'
import type { QueryRoutingDeps } from '../../../../distribution/query/routing'
import { distributedQuery } from '../../../../distribution/query/routing'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
  type NodeTransport,
} from '../../../../distribution/transport'
import type { SearchPayload } from '../../../../distribution/transport/types'
import {
  createSearchResultMessage,
  makeAllocationTable,
  makeAssignment,
  makeQueryParams,
  makeSearchResultResponse,
  setupDataNode,
} from './fixtures'

describe('distributedQuery facet shard size computation', () => {
  let network: InMemoryNetwork
  let coordinatorTransport: NodeTransport
  const transports: NodeTransport[] = []

  function makeDeps(allocationTable: AllocationTable | null): QueryRoutingDeps {
    return {
      transport: coordinatorTransport,
      sourceNodeId: 'coordinator',
      getAllocation: async () => allocationTable,
    }
  }

  beforeEach(() => {
    network = createInMemoryNetwork()
    coordinatorTransport = createInMemoryTransport('coordinator', network)
    transports.push(coordinatorTransport)
  })

  afterEach(async () => {
    for (const t of transports) {
      await t.shutdown()
    }
    transports.length = 0
  })

  it('includes facetShardSize in the search payload when facets are requested', async () => {
    const capturedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['color'] }), makeDeps(table))

    expect(capturedPayloads).toHaveLength(1)
    expect(capturedPayloads[0].facetShardSize).toBe(Math.ceil(10 * 1.5) + 10)
  })

  it('computes facetShardSize from params.facetSize when provided', async () => {
    const capturedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['category'], facetSize: 20 }), makeDeps(table))

    expect(capturedPayloads).toHaveLength(1)
    expect(capturedPayloads[0].facetShardSize).toBe(Math.ceil(20 * 1.5) + 10)
  })

  it('computes facetShardSize from config.defaultFacetSize when params.facetSize is null', async () => {
    const capturedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['brand'], facetSize: null }), makeDeps(table), {
      defaultFacetSize: 50,
    })

    expect(capturedPayloads).toHaveLength(1)
    expect(capturedPayloads[0].facetShardSize).toBe(Math.ceil(50 * 1.5) + 10)
  })

  it('clamps facetSize: 0 to 1', async () => {
    const capturedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['color'], facetSize: 0 }), makeDeps(table))

    expect(capturedPayloads).toHaveLength(1)
    expect(capturedPayloads[0].facetShardSize).toBe(Math.ceil(1 * 1.5) + 10)
  })

  it('clamps facetSize: -1 to 1', async () => {
    const capturedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['color'], facetSize: -1 }), makeDeps(table))

    expect(capturedPayloads).toHaveLength(1)
    expect(capturedPayloads[0].facetShardSize).toBe(Math.ceil(1 * 1.5) + 10)
  })

  it('falls back to default when facetSize is NaN', async () => {
    const capturedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['color'], facetSize: NaN }), makeDeps(table))

    expect(capturedPayloads).toHaveLength(1)
    expect(capturedPayloads[0].facetShardSize).toBe(Math.ceil(10 * 1.5) + 10)
  })

  it('clamps facetSize: 999_999 to MAX_FACET_SIZE', async () => {
    const capturedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: ['color'], facetSize: 999_999 }), makeDeps(table))

    expect(capturedPayloads).toHaveLength(1)
    expect(capturedPayloads[0].facetShardSize).toBe(Math.ceil(1_000 * 1.5) + 10)
  })

  it('does not compute facetShardSize when no facets are requested', async () => {
    const capturedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: null }), makeDeps(table))

    expect(capturedPayloads).toHaveLength(1)
    expect(capturedPayloads[0].facetShardSize).toBeNull()
  })

  it('does not compute facetShardSize when facets array is empty', async () => {
    const capturedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
      const resultPayload = makeSearchResultResponse([
        { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
      ])
      respond(createSearchResultMessage(resultPayload, 'node-a', msg.requestId))
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ facets: [] }), makeDeps(table))

    expect(capturedPayloads).toHaveLength(1)
    expect(capturedPayloads[0].facetShardSize).toBeNull()
  })
})
