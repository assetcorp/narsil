import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClusterLocalEngine } from '../../../../distribution/cluster-node/local-engine'
import { createClusterLocalEngine } from '../../../../distribution/cluster-node/local-engine'
import { localParamsToWire } from '../../../../distribution/cluster-node/query-conversion'
import type { QueryRoutingDeps } from '../../../../distribution/query/routing'
import { distributedQuery } from '../../../../distribution/query/routing'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
  type NodeTransport,
} from '../../../../distribution/transport'
import type { QueryParams } from '../../../../types/search'
import {
  createSearchResultMessage,
  makeAllocationTable,
  makeAssignment,
  makeSearchResultResponse,
  setupDataNode,
} from './fixtures'

describe('cursor transition between the local fallback and the distributed path', () => {
  let network: InMemoryNetwork
  let coordinatorTransport: NodeTransport
  let engine: ClusterLocalEngine
  const transports: NodeTransport[] = []

  function makeDeps(): QueryRoutingDeps {
    return {
      transport: coordinatorTransport,
      sourceNodeId: 'coordinator',
      getAllocation: async () => makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]]),
    }
  }

  beforeEach(async () => {
    network = createInMemoryNetwork()
    coordinatorTransport = createInMemoryTransport('coordinator', network)
    transports.push(coordinatorTransport)
    engine = await createClusterLocalEngine()
    await engine.createIndex('products', { schema: { title: 'string', price: 'number' } })
    await engine.insert('products', { title: 'wireless keyboard', price: 40 }, 'doc-1')
    await engine.insert('products', { title: 'wireless mechanical keyboard', price: 90 }, 'doc-2')
    await engine.insert('products', { title: 'wireless mouse', price: 20 }, 'doc-3')
  })

  afterEach(async () => {
    await engine.shutdown()
    for (const t of transports) {
      await t.shutdown()
    }
    transports.length = 0
  })

  const shapes: Array<[string, QueryParams]> = [
    ['a plain term query', { term: 'wireless', limit: 1 }],
    ['a termMatch all query', { term: 'wireless keyboard', termMatch: 'all', limit: 1 }],
    ['an exact query with a boost', { term: 'wireless', exact: true, boost: { title: 2 }, limit: 1 }],
    ['a filtered query', { term: 'wireless', filters: { fields: { price: { gt: 10 } } }, limit: 1 }],
    ['a pinned query', { term: 'wireless', pinned: [{ docId: 'doc-3', position: 0 }], limit: 2 }],
  ]

  for (const [name, params] of shapes) {
    it(`accepts a locally issued cursor on the distributed path for ${name}`, async () => {
      const local = await engine.query('products', params)
      expect(local.cursor).toBeDefined()

      setupDataNode(network, transports, 'node-a', (msg, respond) => {
        respond(
          createSearchResultMessage(
            makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-9', score: 1 }], totalHits: 1 }]),
            'node-a',
            msg.requestId,
          ),
        )
      })

      const wire = localParamsToWire({ ...params, searchAfter: local.cursor })
      await expect(distributedQuery('products', wire, makeDeps())).resolves.toMatchObject({ totalHits: 1 })
    })
  }

  it('accepts a distributed cursor on the local fallback', async () => {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      respond(
        createSearchResultMessage(
          makeSearchResultResponse([
            {
              partitionId: 0,
              scored: [
                { docId: 'doc-1', score: 8 },
                { docId: 'doc-2', score: 4 },
              ],
              totalHits: 2,
            },
          ]),
          'node-a',
          msg.requestId,
        ),
      )
    })

    const params: QueryParams = { term: 'wireless keyboard', termMatch: 'all', limit: 1 }
    const distributed = await distributedQuery('products', localParamsToWire(params), makeDeps())
    expect(distributed.cursor).not.toBeNull()

    const local = await engine.query('products', { ...params, searchAfter: distributed.cursor ?? undefined })
    expect(local.hits.length).toBeGreaterThanOrEqual(0)
  })
})
