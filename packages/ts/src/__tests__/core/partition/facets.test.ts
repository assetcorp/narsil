import { describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../../core/partition'
import { createCompositePartition } from '../../../core/partition/composite'
import { computeFacets, type FacetMatchSet } from '../../../core/partition/facets'
import { createFrozenSegment, type FrozenSegment } from '../../../core/partition/frozen'
import { partitionStateOf } from '../../../core/partition/index'
import { getAllDocIds } from '../../../core/partition/utils'
import type { InternalSearchParams } from '../../../types/internal'
import type { AnyDocument, SchemaDefinition } from '../../../types/schema'
import { english } from '../partition-index/fixtures'

const facetSchema: SchemaDefinition = {
  title: 'string',
  label: 'string',
  aliases: 'string[]',
  category: 'enum',
  tags: 'enum[]',
  price: 'number',
  scores: 'number[]',
  active: 'boolean',
  flags: 'boolean[]',
}

const corpus: AnyDocument[] = [
  {
    id: 'doc-1',
    title: 'apple one',
    label: 'x',
    aliases: ['x', 'x'],
    category: 'fruit',
    tags: ['red', 'red', 'blue'],
    price: 5,
    scores: [5, 5, 7],
    active: true,
    flags: [true, true],
  },
  {
    id: 'doc-2',
    title: 'apple two',
    label: 'y',
    aliases: ['y'],
    category: 'fruit',
    tags: ['red'],
    price: 3,
    scores: [2, 9],
    active: false,
    flags: [false],
  },
  {
    id: 'doc-3',
    title: 'banana three',
    label: 'x',
    aliases: ['x', 'z'],
    category: 'metal',
    tags: ['blue', 'green'],
    price: 7,
    scores: [5],
    active: true,
    flags: [true, false],
  },
]

function buildLive(documents: AnyDocument[] = corpus): PartitionIndex {
  const live = createPartitionIndex(0)
  for (const doc of documents) {
    live.insert(String(doc.id), doc, facetSchema, english, { collectSurfaces: true })
  }
  return live
}

function ordinalSetOf(partition: PartitionIndex, docIds: Set<string>): FacetMatchSet {
  const state = partitionStateOf(partition)
  const capacity = state.docStore.internalIdCapacity()
  const bitset = new Uint32Array(Math.ceil(capacity / 32) || 1)
  for (const docId of docIds) {
    const ordinal = state.docStore.getInternalId(docId)
    if (ordinal === undefined) continue
    bitset[ordinal >> 5] |= 1 << (ordinal & 31)
  }
  return { ordinalBitset: bitset }
}

function termParams(overrides: Partial<InternalSearchParams> & { tokens: string[] }): InternalSearchParams {
  const { tokens, ...rest } = overrides
  return {
    queryTokens: tokens.map((token, position) => ({ token, position })),
    tolerance: 0,
    prefixLength: 2,
    exact: true,
    ...rest,
  }
}

describe('facet counting reads the field indexes', () => {
  it('counts indexed facets identically from external ids and from ordinals', () => {
    const live = buildLive()
    const allIds = getAllDocIds(partitionStateOf(live).docStore)
    const config = { category: {}, tags: {}, price: {}, scores: {}, active: {}, flags: {} }

    const fromIds = live.computeFacets(allIds, config, facetSchema)
    const fromOrdinals = live.computeFacets(ordinalSetOf(live, allIds), config, facetSchema)

    expect(fromOrdinals).toEqual(fromIds)
    expect(fromIds.category.values).toEqual({ fruit: 2, metal: 1 })
    expect(fromIds.active.values).toEqual({ true: 2, false: 1 })
    expect(fromIds.flags.values).toEqual({ true: 2, false: 2 })
    expect(fromIds.price.values).toEqual({ '5': 1, '3': 1, '7': 1 })
  })

  it('counts a value repeated inside one document array once', () => {
    const live = buildLive()
    const allIds = getAllDocIds(partitionStateOf(live).docStore)

    const facets = live.computeFacets(allIds, { tags: {}, scores: {}, flags: {} }, facetSchema)

    expect(facets.tags.values).toEqual({ red: 2, blue: 2, green: 1 })
    expect(facets.scores.values).toEqual({ '5': 2, '7': 1, '2': 1, '9': 1 })
    expect(facets.flags.values.true).toBe(2)
  })

  it('keeps the stored-document scan for string fields', () => {
    const live = buildLive()
    const allIds = getAllDocIds(partitionStateOf(live).docStore)
    const config = { label: {}, aliases: {} }

    const fromIds = live.computeFacets(allIds, config, facetSchema)
    const fromOrdinals = live.computeFacets(ordinalSetOf(live, allIds), config, facetSchema)

    expect(fromOrdinals).toEqual(fromIds)
    expect(fromIds.label.values).toEqual({ x: 2, y: 1 })
    expect(fromIds.aliases.values).toEqual({ x: 3, y: 1, z: 1 })
  })

  it('counts numeric ranges as distinct documents over half-open bounds', () => {
    const live = buildLive()
    const allIds = getAllDocIds(partitionStateOf(live).docStore)

    const priceFacets = live.computeFacets(
      allIds,
      {
        price: {
          ranges: [
            { from: 0, to: 5 },
            { from: 5, to: 10 },
            { from: 5, to: 7 },
            { from: 20, to: 30 },
            { from: 7, to: 3 },
            { from: Number.NaN, to: 10 },
          ],
        },
      },
      facetSchema,
    )

    expect(priceFacets.price.values['0-5']).toBe(1)
    expect(priceFacets.price.values['5-10']).toBe(2)
    expect(priceFacets.price.values['5-7']).toBe(1)
    expect(priceFacets.price.values['20-30']).toBe(0)
    expect(priceFacets.price.values['7-3']).toBe(0)
    expect(priceFacets.price.values['NaN-10']).toBe(0)

    const scoreFacets = live.computeFacets(
      allIds,
      {
        scores: {
          ranges: [
            { from: 0, to: 6 },
            { from: 6, to: 10 },
          ],
        },
      },
      facetSchema,
    )

    expect(scoreFacets.scores.values['0-6']).toBe(3)
    expect(scoreFacets.scores.values['6-10']).toBe(2)
  })

  it('restricts every count to the matched set', () => {
    const live = buildLive()
    const matched = new Set(['doc-1'])
    const config = { tags: {}, price: {}, active: {}, label: {} }

    const fromIds = live.computeFacets(matched, config, facetSchema)
    const fromOrdinals = live.computeFacets(ordinalSetOf(live, matched), config, facetSchema)

    expect(fromOrdinals).toEqual(fromIds)
    expect(fromIds.tags.values).toEqual({ red: 1, blue: 1 })
    expect(fromIds.price.values).toEqual({ '5': 1 })
    expect(fromIds.active.values).toEqual({ true: 1 })
    expect(fromIds.label.values).toEqual({ x: 1 })
  })

  it('sorts facet values by count and applies the limit to indexed fields', () => {
    const live = buildLive()
    const allIds = getAllDocIds(partitionStateOf(live).docStore)

    const facets = live.computeFacets(allIds, { tags: { limit: 2, sort: 'desc' } }, facetSchema)

    expect(Object.keys(facets.tags.values)).toEqual(['blue', 'red'])
    expect(facets.tags.count).toBe(2)

    const ascending = live.computeFacets(allIds, { tags: { sort: 'asc' } }, facetSchema)
    expect(Object.keys(ascending.tags.values)).toEqual(['green', 'blue', 'red'])
  })

  it('ignores a facet field the schema does not declare', () => {
    const live = buildLive()
    const allIds = getAllDocIds(partitionStateOf(live).docStore)

    const facets = live.computeFacets(allIds, { missing: {} }, facetSchema)

    expect(facets.missing).toBeUndefined()
  })
})

describe('a frozen segment counts facets like the live partition', () => {
  function buildFrozenPair(): { live: PartitionIndex; frozen: FrozenSegment } {
    const live = buildLive()
    return { live, frozen: createFrozenSegment(live.encodeSegment(), corpus) }
  }

  it('matches the live counts for every field kind', () => {
    const { live, frozen } = buildFrozenPair()
    const allIds = getAllDocIds(frozen.docStore)
    const config = {
      category: {},
      tags: {},
      price: { ranges: [{ from: 0, to: 6 }] },
      scores: {},
      active: {},
      flags: {},
      label: {},
      aliases: {},
    }

    const liveFacets = live.computeFacets(allIds, config, facetSchema)
    const frozenFacets = computeFacets(frozen, allIds, config, facetSchema)

    expect(frozenFacets).toEqual(liveFacets)
  })

  it('excludes a tombstoned document from every count', () => {
    const { frozen } = buildFrozenPair()
    frozen.tombstoneDocument('doc-1')
    const allIds = getAllDocIds(frozen.docStore)
    const config = { tags: {}, price: { ranges: [{ from: 0, to: 10 }] }, scores: {}, active: {}, label: {} }

    const facets = computeFacets(frozen, allIds, config, facetSchema)

    expect(facets.tags.values).toEqual({ red: 1, blue: 1, green: 1 })
    expect(facets.price.values['0-10']).toBe(2)
    expect(facets.scores.values).toEqual({ '5': 1, '2': 1, '9': 1 })
    expect(facets.active.values).toEqual({ true: 1, false: 1 })
    expect(facets.label.values).toEqual({ x: 1, y: 1 })
  })
})

describe('a composite partition counts facets from composite ordinals', () => {
  function buildComposite(): { baseline: PartitionIndex; composite: ReturnType<typeof createCompositePartition> } {
    const baseline = buildLive()
    const composite = createCompositePartition(0)
    const frozenDocs = corpus.slice(0, 2)
    const scratch = buildLive(frozenDocs)
    composite.appendFrozenSegment(scratch.encodeSegment(), frozenDocs)
    for (const doc of corpus.slice(2)) {
      composite.insert(String(doc.id), doc, facetSchema, english, { collectSurfaces: true })
    }
    return { baseline, composite }
  }

  it('matches the merged baseline from a search match bitset and from external ids', () => {
    const { baseline, composite } = buildComposite()
    const params = termParams({ tokens: ['apple', 'banana'] })
    const config = { category: {}, tags: {}, price: { ranges: [{ from: 0, to: 6 }] }, scores: {}, label: {} }

    const baseFacets = baseline.computeFacets(
      { ordinalBitset: baseline.searchFulltextMatches(params).ordinalBitset() },
      config,
      facetSchema,
    )
    const compositeFromBitset = composite.computeFacets(
      { ordinalBitset: composite.searchFulltextMatches(params).ordinalBitset() },
      config,
      facetSchema,
    )
    const compositeFromIds = composite.computeFacets(
      composite.searchFulltextMatches(params).matchedDocIds(),
      config,
      facetSchema,
    )

    expect(compositeFromBitset).toEqual(baseFacets)
    expect(compositeFromIds).toEqual(baseFacets)
  })

  it('returns the matched ordinal bitset from a scoring search when asked', () => {
    const { baseline, composite } = buildComposite()
    const params = termParams({ tokens: ['apple'], collectMatchedSet: 'ordinals' })
    const config = { tags: {}, price: {} }

    const baseResult = baseline.searchFulltext(params)
    const compositeResult = composite.searchFulltext(params)
    if (baseResult.matchedOrdinalBitset === undefined || compositeResult.matchedOrdinalBitset === undefined) {
      throw new Error('The search did not return the matched ordinal bitset')
    }

    const baseFacets = baseline.computeFacets({ ordinalBitset: baseResult.matchedOrdinalBitset }, config, facetSchema)
    const compositeFacets = composite.computeFacets(
      { ordinalBitset: compositeResult.matchedOrdinalBitset },
      config,
      facetSchema,
    )

    expect(compositeFacets).toEqual(baseFacets)
    expect(baseFacets.tags.values).toEqual({ red: 2, blue: 1 })
  })

  it('still returns external ids from a scoring search when asked', () => {
    const { composite } = buildComposite()
    const params = termParams({ tokens: ['apple'], collectMatchedSet: 'ids' })

    const result = composite.searchFulltext(params)

    expect(result.matchedOrdinalBitset).toBeUndefined()
    expect(new Set(result.matchedIds)).toEqual(new Set(['doc-1', 'doc-2']))
  })
})
