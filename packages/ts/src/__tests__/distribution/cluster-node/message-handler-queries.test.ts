import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { handleSearch } from '../../../distribution/cluster-node/message-handler/queries'
import type { DataNodeHandlerDeps } from '../../../distribution/cluster-node/message-handler/types'
import { wireParamsToLocal } from '../../../distribution/cluster-node/query-conversion'
import type { SearchResultPayload, TransportMessage, WireQueryParams } from '../../../distribution/transport/types'
import { QueryMessageTypes } from '../../../distribution/transport/types'
import { encodePageCursor } from '../../../search/cursor'
import { queryBindingOf } from '../../../search/cursor-binding'

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
    includeScores: null,
    scoring: 'local',
    termMatch: null,
    prefixLength: null,
    prefix: null,
    exact: null,
    pinned: null,
    mode: null,
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
        schema: { title: 'string:sortable', description: 'string', price: 'number' },
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
        async response => {
          responses.push(response)
        },
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
      expect(scored.map(entry => entry.score)).toEqual([null, null, null])
    } finally {
      await engine.shutdown()
    }
  })

  it('carries scores on a sorted query only where the coordinator asks for them', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndex('products', { schema: { title: 'string:sortable', description: 'string' } })
      await engine.insert('products', { title: 'alpha', description: 'listed item' }, 'doc-1')
      await engine.insert('products', { title: 'beta', description: 'listed item' }, 'doc-2')

      const deps = { nodeId: 'node-a', engine } as DataNodeHandlerDeps
      const responses: TransportMessage[] = []
      await handleSearch(
        makeSearchMessage(
          makeWireParams({
            term: 'item',
            sort: [{ field: 'title', direction: 'asc' }],
            includeScores: true,
          }),
        ),
        async response => {
          responses.push(response)
        },
        deps,
      )

      const scored = (decode(responses[0].payload) as SearchResultPayload).results[0].scored
      expect(scored.map(entry => entry.docId)).toEqual(['doc-1', 'doc-2'])
      for (const entry of scored) {
        expect(typeof entry.score).toBe('number')
      }
    } finally {
      await engine.shutdown()
    }
  })

  it('keeps the wire order of a sort naming an all-digit field', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndex('products', { schema: { title: 'string:sortable', 2024: 'number' } })
      await engine.insert('products', { title: 'alpha listed item', 2024: 1 }, 'doc-1')
      await engine.insert('products', { title: 'beta listed item', 2024: 9 }, 'doc-2')

      const deps = { nodeId: 'node-a', engine } as DataNodeHandlerDeps
      const responses: TransportMessage[] = []
      await handleSearch(
        makeSearchMessage(
          makeWireParams({
            term: 'item',
            sort: [
              { field: 'title', direction: 'desc' },
              { field: '2024', direction: 'asc' },
            ],
          }),
        ),
        async response => {
          responses.push(response)
        },
        deps,
      )

      const scored = (decode(responses[0].payload) as SearchResultPayload).results[0].scored
      expect(scored.map(entry => entry.docId)).toEqual(['doc-2', 'doc-1'])
      expect(scored.map(entry => entry.sortValues)).toEqual([
        ['beta listed item', 9],
        ['alpha listed item', 1],
      ])
    } finally {
      await engine.shutdown()
    }
  })

  it('leaves pinning to the coordinator on a partition-scoped search', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndex('products', { schema: { title: 'string' } })
      await engine.insert('products', { title: 'widget spanner' }, 'doc-1')
      await engine.insert('products', { title: 'widget wrench' }, 'doc-2')
      await engine.insert('products', { title: 'unrelated' }, 'doc-3')

      const deps = { nodeId: 'node-a', engine } as DataNodeHandlerDeps
      const responses: TransportMessage[] = []
      await handleSearch(
        makeSearchMessage(
          makeWireParams({
            term: 'widget',
            pinned: [
              { docId: 'doc-3', position: 0 },
              { docId: 'doc-2', position: 1 },
            ],
          }),
        ),
        async response => {
          responses.push(response)
        },
        deps,
      )

      const scored = (decode(responses[0].payload) as SearchResultPayload).results[0].scored
      expect(scored.map(entry => entry.docId)).not.toContain('doc-3')
      expect(scored.map(entry => entry.docId)).toContain('doc-2')
      for (const entry of scored) {
        expect(entry.score).not.toBe(0)
      }
    } finally {
      await engine.shutdown()
    }
  })

  it('accepts a coordinator cursor whose binding covers pinned', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndex('products', { schema: { title: 'string' } })
      await engine.insert('products', { title: 'widget spanner' }, 'doc-1')
      await engine.insert('products', { title: 'widget wrench' }, 'doc-2')

      const params = makeWireParams({ term: 'widget', pinned: [{ docId: 'doc-2', position: 0 }], limit: 1 })
      const cursor = encodePageCursor({
        anchor: 'doc-1',
        score: 5,
        sortKey: null,
        sortSignature: null,
        binding: queryBindingOf(wireParamsToLocal(params)),
      })

      const deps = { nodeId: 'node-a', engine } as DataNodeHandlerDeps
      const responses: TransportMessage[] = []
      await handleSearch(
        makeSearchMessage({ ...params, searchAfter: cursor }),
        async response => {
          responses.push(response)
        },
        deps,
      )

      expect(responses).toHaveLength(1)
    } finally {
      await engine.shutdown()
    }
  })

  it('honours termMatch all on a partition-scoped search', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndex('products', { schema: { title: 'string' } })
      await engine.insert('products', { title: 'wireless keyboard' }, 'doc-1')
      await engine.insert('products', { title: 'wireless mouse' }, 'doc-2')

      const deps = { nodeId: 'node-a', engine } as DataNodeHandlerDeps
      const responses: TransportMessage[] = []
      await handleSearch(
        makeSearchMessage(makeWireParams({ term: 'wireless keyboard', termMatch: 'all' })),
        async response => {
          responses.push(response)
        },
        deps,
      )

      const scored = (decode(responses[0].payload) as SearchResultPayload).results[0].scored
      expect(scored.map(entry => entry.docId)).toEqual(['doc-1'])
    } finally {
      await engine.shutdown()
    }
  })

  it('returns its groups with per-group entries on a grouped search', async () => {
    const engine = await createClusterLocalEngine()
    try {
      await engine.createIndex('products', { schema: { title: 'string', category: 'string' } })
      await engine.insert('products', { title: 'widget spanner', category: 'tools' }, 'doc-1')
      await engine.insert('products', { title: 'widget wrench', category: 'tools' }, 'doc-2')
      await engine.insert('products', { title: 'widget mug', category: 'kitchen' }, 'doc-3')

      const deps = { nodeId: 'node-a', engine } as DataNodeHandlerDeps
      const responses: TransportMessage[] = []
      await handleSearch(
        makeSearchMessage(
          makeWireParams({ term: 'widget', group: { fields: ['category'], maxPerGroup: 2, limit: null } }),
        ),
        async response => {
          responses.push(response)
        },
        deps,
      )

      const payload = decode(responses[0].payload) as SearchResultPayload
      const groups = payload.groups ?? []
      expect(groups).toHaveLength(2)
      const tools = groups.find(group => group.values.category === 'tools')
      expect(tools?.scored.map(entry => entry.docId).sort()).toEqual(['doc-1', 'doc-2'])
      for (const group of groups) {
        for (const entry of group.scored) {
          expect(typeof entry.docId).toBe('string')
        }
      }
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
        async response => {
          responses.push(response)
        },
        deps,
      )

      const payload = decode(responses[0].payload) as SearchResultPayload
      expect(payload.results[0].scored[0].sortValues).toBeNull()
    } finally {
      await engine.shutdown()
    }
  })
})
