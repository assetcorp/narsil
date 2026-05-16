import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AllocationTable } from '../../../../distribution/coordinator/types'
import { decodePayload } from '../../../../distribution/query/codec'
import { distributedQuery } from '../../../../distribution/query/routing'
import type { QueryRoutingDeps } from '../../../../distribution/query/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
  type NodeTransport,
  QueryMessageTypes,
} from '../../../../distribution/transport'
import type { SearchPayload } from '../../../../distribution/transport/types'
import {
  makeAllocationTable,
  makeAssignment,
  makeHybridConfig,
  makeQueryParams,
  makeSearchResultResponse,
  makeVectorParams,
  setupDataNode,
} from './fixtures'

describe('distributed hybrid query - fan-out behavior', () => {
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

  it('sends two separate search messages to each data node for hybrid queries', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        receivedPayloads.push(decodePayload<SearchPayload>(msg.payload))
        const resultPayload = makeSearchResultResponse([
          { partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 },
        ])
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(resultPayload),
        })
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery(
      'products',
      makeQueryParams({ term: 'laptop', vector: makeVectorParams(), hybrid: makeHybridConfig() }),
      makeDeps(table),
    )

    expect(receivedPayloads).toHaveLength(2)

    const textPayload = receivedPayloads.find(p => p.params.term !== null && p.params.vector === null)
    const vectorPayload = receivedPayloads.find(p => p.params.term === null && p.params.vector !== null)

    expect(textPayload).toBeDefined()
    expect(vectorPayload).toBeDefined()
    expect(textPayload?.params.hybrid).toBeNull()
    expect(vectorPayload?.params.hybrid).toBeNull()
  })

  it('sends two messages per node when multiple nodes exist', async () => {
    const nodeAPayloads: SearchPayload[] = []
    const nodeBPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        nodeAPayloads.push(decodePayload<SearchPayload>(msg.payload))
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(
            makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 }]),
          ),
        })
      }
    })

    setupDataNode(network, transports, 'node-b', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        nodeBPayloads.push(decodePayload<SearchPayload>(msg.payload))
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-b',
          requestId: msg.requestId,
          payload: encode(
            makeSearchResultResponse([{ partitionId: 1, scored: [{ docId: 'doc-2', score: 4.0 }], totalHits: 1 }]),
          ),
        })
      }
    })

    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a' })],
      [1, makeAssignment({ primary: 'node-b' })],
    ])

    await distributedQuery(
      'products',
      makeQueryParams({ term: 'laptop', vector: makeVectorParams(), hybrid: makeHybridConfig() }),
      makeDeps(table),
    )

    expect(nodeAPayloads).toHaveLength(2)
    expect(nodeBPayloads).toHaveLength(2)
  })

  it('follows the single-fan-out path for non-hybrid queries', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        receivedPayloads.push(decodePayload<SearchPayload>(msg.payload))
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(
            makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 }]),
          ),
        })
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery('products', makeQueryParams({ term: 'laptop', hybrid: null }), makeDeps(table))

    expect(receivedPayloads).toHaveLength(1)
    expect(receivedPayloads[0].params.term).toBe('laptop')
  })

  it('follows the single-fan-out path for vector-only queries without hybrid', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        receivedPayloads.push(decodePayload<SearchPayload>(msg.payload))
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(
            makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-1', score: 0.9 }], totalHits: 1 }]),
          ),
        })
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery(
      'products',
      makeQueryParams({ term: null, vector: makeVectorParams(), hybrid: null }),
      makeDeps(table),
    )

    expect(receivedPayloads).toHaveLength(1)
    expect(receivedPayloads[0].params.vector).not.toBeNull()
    expect(receivedPayloads[0].params.term).toBeNull()
  })

  it('does not enter hybrid path when term is null (even if hybrid config is set)', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        receivedPayloads.push(decodePayload<SearchPayload>(msg.payload))
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(
            makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-1', score: 0.9 }], totalHits: 1 }]),
          ),
        })
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery(
      'products',
      makeQueryParams({ term: null, vector: makeVectorParams(), hybrid: makeHybridConfig() }),
      makeDeps(table),
    )

    expect(receivedPayloads).toHaveLength(1)
  })

  it('does not enter hybrid path when vector is null (even if hybrid config is set)', async () => {
    const receivedPayloads: SearchPayload[] = []

    setupDataNode(network, transports, 'node-a', (msg, respond) => {
      if (msg.type === QueryMessageTypes.SEARCH) {
        receivedPayloads.push(decodePayload<SearchPayload>(msg.payload))
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-a',
          requestId: msg.requestId,
          payload: encode(
            makeSearchResultResponse([{ partitionId: 0, scored: [{ docId: 'doc-1', score: 5.0 }], totalHits: 1 }]),
          ),
        })
      }
    })

    const table = makeAllocationTable([[0, makeAssignment({ primary: 'node-a' })]])
    await distributedQuery(
      'products',
      makeQueryParams({ term: 'laptop', vector: null, hybrid: makeHybridConfig() }),
      makeDeps(table),
    )

    expect(receivedPayloads).toHaveLength(1)
  })
})
