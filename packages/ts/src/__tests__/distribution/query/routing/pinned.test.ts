import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wireParamsToLocal } from '../../../../distribution/cluster-node/query-conversion'
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
import { encodePageCursor } from '../../../../search/cursor'
import { queryBindingOf } from '../../../../search/cursor-binding'
import {
  createSearchResultMessage,
  makeAllocationTable,
  makeAssignment,
  makeQueryParams,
  makeSearchResultResponse,
  setupDataNode,
} from './fixtures'

describe('distributedQuery pinned placement', () => {
  let network: InMemoryNetwork
  let coordinatorTransport: NodeTransport
  const transports: NodeTransport[] = []
  const capturedPayloads: SearchPayload[] = []

  function makeDeps(allocationTable: AllocationTable | null): QueryRoutingDeps {
    return {
      transport: coordinatorTransport,
      sourceNodeId: 'coordinator',
      getAllocation: async () => allocationTable,
    }
  }

  function nodeWithScored(scored: Array<{ docId: string; score: number }>, totalHits = scored.length): void {
    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      capturedPayloads.push(decodePayload<SearchPayload>(msg.payload))
      respond(
        createSearchResultMessage(
          makeSearchResultResponse([{ partitionId: 0, scored, totalHits }]),
          'node-a',
          msg.requestId,
        ),
      )
    })
  }

  const table = () => makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])

  beforeEach(() => {
    network = createInMemoryNetwork()
    coordinatorTransport = createInMemoryTransport('coordinator', network)
    transports.push(coordinatorTransport)
    capturedPayloads.length = 0
  })

  afterEach(async () => {
    for (const t of transports) {
      await t.shutdown()
    }
    transports.length = 0
  })

  it('places an unmatched pinned document at its position with a zero score', async () => {
    nodeWithScored([
      { docId: 'organic-1', score: 9 },
      { docId: 'organic-2', score: 5 },
    ])
    const params = makeQueryParams({ pinned: [{ docId: 'sponsored', position: 0 }] })
    const result = await distributedQuery('products', params, makeDeps(table()))

    expect(result.scored.map(entry => entry.docId)).toEqual(['sponsored', 'organic-1', 'organic-2'])
    expect(result.scored[0].score).toBe(0)
  })

  it('moves a matched document to its pinned position without duplicating it', async () => {
    nodeWithScored([
      { docId: 'organic-1', score: 9 },
      { docId: 'organic-2', score: 5 },
      { docId: 'organic-3', score: 2 },
    ])
    const params = makeQueryParams({ pinned: [{ docId: 'organic-3', position: 0 }] })
    const result = await distributedQuery('products', params, makeDeps(table()))

    expect(result.scored.map(entry => entry.docId)).toEqual(['organic-3', 'organic-1', 'organic-2'])
  })

  it('applies positions before the offset slice', async () => {
    nodeWithScored([
      { docId: 'organic-1', score: 9 },
      { docId: 'organic-2', score: 5 },
    ])
    const params = makeQueryParams({ pinned: [{ docId: 'sponsored', position: 0 }], offset: 1, limit: 2 })
    const result = await distributedQuery('products', params, makeDeps(table()))

    expect(result.scored.map(entry => entry.docId)).toEqual(['organic-1', 'organic-2'])
  })

  it('never returns more hits than the limit when a pinned document joins a full page', async () => {
    nodeWithScored(
      [
        { docId: 'organic-1', score: 9 },
        { docId: 'organic-2', score: 5 },
      ],
      50,
    )
    const params = makeQueryParams({ pinned: [{ docId: 'sponsored', position: 0 }], limit: 2 })
    const result = await distributedQuery('products', params, makeDeps(table()))

    expect(result.scored.map(entry => entry.docId)).toEqual(['sponsored', 'organic-1'])
  })

  it('skips a position beyond a full result window', async () => {
    nodeWithScored(
      [
        { docId: 'organic-1', score: 9 },
        { docId: 'organic-2', score: 5 },
      ],
      50,
    )
    const params = makeQueryParams({ pinned: [{ docId: 'sponsored', position: 10 }], limit: 2 })
    const result = await distributedQuery('products', params, makeDeps(table()))

    expect(result.scored.map(entry => entry.docId)).toEqual(['organic-1', 'organic-2'])
  })

  it('clamps a position past the end when every hit is present', async () => {
    nodeWithScored([{ docId: 'organic-1', score: 9 }])
    const params = makeQueryParams({ pinned: [{ docId: 'sponsored', position: 10 }], limit: 5 })
    const result = await distributedQuery('products', params, makeDeps(table()))

    expect(result.scored.map(entry => entry.docId)).toEqual(['organic-1', 'sponsored'])
  })

  it('forwards pinned unchanged and leaves a cursor page unpinned', async () => {
    nodeWithScored([{ docId: 'organic-1', score: 4 }])
    const params = makeQueryParams({ pinned: [{ docId: 'sponsored', position: 0 }] })
    const cursor = encodePageCursor({
      anchor: 'organic-0',
      score: 6,
      sortKey: null,
      sortSignature: null,
      binding: queryBindingOf(wireParamsToLocal(params)),
    })
    const result = await distributedQuery('products', { ...params, searchAfter: cursor }, makeDeps(table()))

    expect(capturedPayloads[0].params.pinned).toEqual([{ docId: 'sponsored', position: 0 }])
    expect(result.scored.map(entry => entry.docId)).toEqual(['organic-1'])
  })

  it('issues a cursor whose binding covers the pinned list', async () => {
    nodeWithScored([{ docId: 'organic-1', score: 4 }])
    const params = makeQueryParams({ pinned: [{ docId: 'sponsored', position: 1 }] })
    const result = await distributedQuery('products', params, makeDeps(table()))

    expect(result.cursor).not.toBeNull()
    const followUp = makeQueryParams({ pinned: [{ docId: 'other', position: 1 }], searchAfter: result.cursor })
    await expect(distributedQuery('products', followUp, makeDeps(table()))).rejects.toThrow(/different query/)
  })
})
