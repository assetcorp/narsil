import { describe, expect, it } from 'vitest'
import {
  countIsExactFor,
  distributedResultToLocal,
  localParamsToWire,
  requireClusterFacetOptions,
  wireParamsToLocal,
} from '../../../distribution/cluster-node/query-conversion'
import { queryBindingOf } from '../../../search/cursor-binding'
import type { QueryParams } from '../../../types/search'

function roundTrip(params: QueryParams): QueryParams {
  return wireParamsToLocal(localParamsToWire(params))
}

describe('query param wire round trip', () => {
  const boundShapes: Array<[string, QueryParams]> = [
    ['a plain term query', { term: 'keyboard' }],
    ['termMatch all', { term: 'wireless keyboard', termMatch: 'all' }],
    ['termMatch as a count', { term: 'wireless mechanical keyboard', termMatch: 2 }],
    ['a prefix length', { term: 'keybord', tolerance: 1, prefixLength: 3 }],
    ['prefix completion', { term: 'keyb', prefix: true }],
    ['exact matching', { term: 'keyboard', exact: true }],
    ['pinned documents', { term: 'keyboard', pinned: [{ docId: 'kb-1', position: 0 }] }],
    ['an explicit mode', { term: 'keyboard', mode: 'fulltext' }],
    ['dfs scoring', { term: 'keyboard', scoring: 'dfs' }],
    ['a vector metric', { vector: { field: 'embedding', value: [0.1, 0.2], metric: 'dotProduct' } }],
    ['a vector efSearch', { vector: { field: 'embedding', value: [0.1, 0.2], efSearch: 128 } }],
    ['an empty hybrid config', { term: 'keyboard', vector: { field: 'embedding', value: [0.1] }, hybrid: {} }],
    [
      'a partial hybrid config',
      { term: 'keyboard', vector: { field: 'embedding', value: [0.1] }, hybrid: { strategy: 'linear' } },
    ],
    [
      'every bound member at once',
      {
        term: 'wireless keyboard',
        fields: ['title'],
        filters: { fields: { price: { gt: 10 } } },
        boost: { title: 2 },
        minScore: 0.5,
        termMatch: 'all',
        tolerance: 1,
        prefixLength: 2,
        prefix: false,
        exact: false,
        pinned: [{ docId: 'kb-1', position: 1 }],
        mode: 'hybrid',
        hybrid: { strategy: 'rrf', k: 40 },
        vector: { field: 'embedding', value: [0.5, 0.25], metric: 'cosine', efSearch: 64, similarity: 0.1 },
      },
    ],
  ]

  for (const [name, params] of boundShapes) {
    it(`binds equally after the round trip for ${name}`, () => {
      expect(queryBindingOf(roundTrip(params))).toBe(queryBindingOf(params))
    })
  }

  it('binds differently once a round-tripped member changes', () => {
    const params: QueryParams = { term: 'keyboard', termMatch: 'all' }
    expect(queryBindingOf(roundTrip({ ...params, termMatch: 'any' }))).not.toBe(queryBindingOf(params))
  })

  it('restores each carried member to its sent value', () => {
    const restored = roundTrip({
      term: 'keyboard',
      termMatch: 3,
      prefixLength: 4,
      prefix: true,
      exact: false,
      pinned: [{ docId: 'kb-2', position: 5 }],
      mode: 'vector',
      vector: { field: 'embedding', value: [1, 2], metric: 'euclidean', efSearch: 256 },
    })
    expect(restored.termMatch).toBe(3)
    expect(restored.prefixLength).toBe(4)
    expect(restored.prefix).toBe(true)
    expect(restored.exact).toBe(false)
    expect(restored.pinned).toEqual([{ docId: 'kb-2', position: 5 }])
    expect(restored.mode).toBe('vector')
    expect(restored.vector).toMatchObject({ metric: 'euclidean', efSearch: 256 })
  })

  it('preserves an absent hybrid member as absent', () => {
    const restored = roundTrip({
      term: 'keyboard',
      vector: { field: 'embedding', value: [0.1] },
      hybrid: { strategy: 'linear' },
    })
    expect(restored.hybrid).toEqual({ strategy: 'linear' })
  })

  it('carries every field of a multi-field group', () => {
    const restored = roundTrip({
      term: 'keyboard',
      group: { fields: ['category', 'brand'], maxPerGroup: 2 },
    })
    expect(restored.group).toEqual({ fields: ['category', 'brand'], maxPerGroup: 2 })
  })

  it('asks each node for one hit per group where the query leaves maxPerGroup out', () => {
    expect(localParamsToWire({ term: 'keyboard', group: { fields: ['brand'] } }).group?.maxPerGroup).toBe(1)
  })

  it('asks each node for up to 10,000 hits per group where the query folds a reducer', () => {
    const wire = localParamsToWire({
      term: 'keyboard',
      group: {
        fields: ['brand'],
        maxPerGroup: 2,
        reduce: { reducer: (total, doc) => (total as number) + (doc.price as number), initialValue: () => 0 },
      },
    })
    expect(wire.group?.maxPerGroup).toBe(10_000)
  })
})

describe('distributed result conversion', () => {
  it('sets a facet count to the number of values returned, as the local engine does', () => {
    const local = distributedResultToLocal(
      {
        scored: [],
        totalHits: 30,
        facets: {
          brand: [
            { value: 'acme', count: 12 },
            { value: 'globex', count: 10 },
          ],
        },
        facetErrorBounds: { brand: 3 },
        groups: null,
        cursor: null,
        coverage: { totalPartitions: 2, queriedPartitions: 2, timedOutPartitions: 0, failedPartitions: 0 },
      },
      true,
    )
    expect(local.facets?.brand).toEqual({ values: { acme: 12, globex: 10 }, count: 2, errorBound: 3 })
  })

  it('cuts each facet to its own limit and adds the largest count it leaves out to the summed node bounds', () => {
    const local = distributedResultToLocal(
      {
        scored: [],
        totalHits: 30,
        facets: {
          brand: [
            { value: 'acme', count: 12 },
            { value: 'globex', count: 10 },
            { value: 'initech', count: 4 },
          ],
        },
        facetErrorBounds: { brand: 3 },
        facetUndercounts: { brand: 3 },
        groups: null,
        cursor: null,
        coverage: { totalPartitions: 2, queriedPartitions: 2, timedOutPartitions: 0, failedPartitions: 0 },
      },
      true,
      new Map(),
      { brand: { limit: 1 } },
    )
    expect(local.facets?.brand).toEqual({ values: { acme: 12 }, count: 1, errorBound: 13 })
  })
})

describe('facet options on the cluster wire', () => {
  it('asks the nodes for as many values as the largest facet limit', () => {
    expect(
      localParamsToWire({ term: 'keyboard', facets: { brand: { limit: 3 }, colour: { limit: 25 } } }).facetSize,
    ).toBe(25)
  })

  it('keeps the default of ten values for a facet that sets no limit', () => {
    expect(localParamsToWire({ term: 'keyboard', facets: { brand: { limit: 3 }, colour: {} } }).facetSize).toBe(10)
  })

  it('refuses facet ranges and ascending facet order, which the wire cannot carry', () => {
    expect(() => requireClusterFacetOptions({ price: { ranges: [{ from: 0, to: 50 }] } })).toThrow(
      expect.objectContaining({ code: 'CLUSTER_OPERATION_UNSUPPORTED' }),
    )
    expect(() => requireClusterFacetOptions({ brand: { sort: 'asc' } })).toThrow(
      expect.objectContaining({ code: 'CLUSTER_OPERATION_UNSUPPORTED' }),
    )
    expect(() => requireClusterFacetOptions({ brand: { sort: 'desc', limit: 5 } })).not.toThrow()
  })
})

describe('the exact count of a cluster vector query', () => {
  it('reports a floor for a vector query that carries text for the engine to embed', () => {
    expect(countIsExactFor({ term: 'harbour', vector: { field: 'embedding', text: 'harbour tides' } })).toBe(false)
    expect(countIsExactFor({ vector: { field: 'embedding', text: 'harbour tides', similarity: 0.8 } })).toBe(false)
  })
})
