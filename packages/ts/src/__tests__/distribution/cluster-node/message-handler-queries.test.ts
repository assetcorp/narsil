import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { handleSearch } from '../../../distribution/cluster-node/message-handler/queries'
import type { DataNodeHandlerDeps } from '../../../distribution/cluster-node/message-handler/types'
import type { SearchResultPayload, TransportMessage, WireQueryParams } from '../../../distribution/transport/types'
import { QueryMessageTypes } from '../../../distribution/transport/types'

function makeWireParams(overrides: Partial<WireQueryParams> = {}): WireQueryParams {
  return {
    term: null,
    filters: null,
    sort: null,
    group: null,
    facets: null,
    facetSize: null,
    limit: 10,
    offset: 0,
    searchAfter: null,
    fields: null,
    boost: null,
    tolerance: null,
    threshold: null,
    scoring: 'local',
    vector: null,
    hybrid: null,
    ...overrides,
  }
}

function makeSearchMessage(params: WireQueryParams): TransportMessage {
  return {
    type: QueryMessageTypes.SEARCH,
    sourceId: 'coordinator',
    requestId: 'search-req',
    payload: encode({
      indexName: 'products',
      partitionIds: [0],
      params,
      globalStats: null,
      facetShardSize: null,
    }),
  }
}

describe('handleSearch on a data node', () => {
  it('returns the raw sort values of every entry when the query carries a sort', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndex('products', {
        schema: { title: 'string', description: 'string', price: 'number' },
      })
      await engine.insert('products', { title: 'Zebra', description: 'listed item', price: 3 }, 'doc-1')
      await engine.insert('products', { title: 'apple', description: 'listed item', price: 2 }, 'doc-2')
      await engine.insert('products', { title: 'Banana', description: 'listed item', price: 1 }, 'doc-3')

      const deps = { nodeId: 'node-a', engine } as DataNodeHandlerDeps
      const responses: TransportMessage[] = []
      await handleSearch(
        makeSearchMessage(
          makeWireParams({
            term: 'item',
            sort: [
              { field: 'title', direction: 'asc' },
              { field: 'price', direction: 'desc' },
            ],
          }),
        ),
        response => responses.push(response),
        deps,
      )

      expect(responses).toHaveLength(1)
      const payload = decode(responses[0].payload) as SearchResultPayload
      const scored = payload.results[0].scored
      expect(scored.map(entry => entry.docId)).toEqual(['doc-2', 'doc-3', 'doc-1'])
      expect(scored.map(entry => entry.sortValues)).toEqual([
        ['apple', 2],
        ['Banana', 1],
        ['Zebra', 3],
      ])
    } finally {
      await engine.shutdown()
    }
  })

  it('returns null sort values when the query has no sort', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndex('products', { schema: { title: 'string' } })
      await engine.insert('products', { title: 'widget spanner' }, 'doc-1')

      const deps = { nodeId: 'node-a', engine } as DataNodeHandlerDeps
      const responses: TransportMessage[] = []
      await handleSearch(
        makeSearchMessage(makeWireParams({ term: 'widget' })),
        response => responses.push(response),
        deps,
      )

      const payload = decode(responses[0].payload) as SearchResultPayload
      expect(payload.results[0].scored[0].sortValues).toBeNull()
    } finally {
      await engine.shutdown()
    }
  })
})
