import { describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../../../core/partition'
import { computeFacets } from '../../../../core/partition/facets'
import { applyPartitionFilters, partitionFilterMatches } from '../../../../core/partition/filters'
import { createFrozenSegment, type FrozenSegment } from '../../../../core/partition/frozen'
import { searchFulltextMatches } from '../../../../core/partition/matches'
import { searchFulltext } from '../../../../core/partition/search'
import { sortedPageOf, sortValuesOf } from '../../../../core/partition/sorting'
import { expandTermPrefix, suggestDisplayTerms } from '../../../../core/partition/suggestions'
import { getAllDocIds } from '../../../../core/partition/utils'
import type { InternalSearchParams } from '../../../../types/internal'
import type { AnyDocument } from '../../../../types/schema'
import { english, simpleSchema } from '../../partition-index/fixtures'

const CATEGORIES = ['fruit', 'metal', 'stone'] as const
const TITLE_WORDS = ['apple', 'apply', 'appli', 'banana', 'copper', 'quartz']

function buildCorpus(count: number): AnyDocument[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${String(i).padStart(3, '0')}`,
    title: `${TITLE_WORDS[i % TITLE_WORDS.length]} ${TITLE_WORDS[(i + 1) % TITLE_WORDS.length]}`,
    body: `${TITLE_WORDS[i % 2]} common ${'apple '.repeat((i % 3) + 1).trim()}`,
    price: i % 10,
    active: i % 2 === 0,
    category: CATEGORIES[i % CATEGORIES.length],
  }))
}

function buildPair(count = 120): { live: PartitionIndex; frozen: FrozenSegment; documents: AnyDocument[] } {
  const documents = buildCorpus(count)
  const live = createPartitionIndex(0)
  for (const doc of documents) {
    live.insert(String(doc.id), doc, simpleSchema, english, { collectSurfaces: true })
  }
  const frozen = createFrozenSegment(live.encodeSegment(), documents)
  return { live, frozen, documents }
}

function termParams(overrides: Partial<InternalSearchParams> & { tokens: string[] }): InternalSearchParams {
  const { tokens, ...rest } = overrides
  return {
    queryTokens: tokens.map((token, position) => ({ token, position })),
    tolerance: 0,
    prefixLength: 2,
    exact: false,
    ...rest,
  }
}

function sortedByIdThenScore(result: { scored: Array<{ docId: string; score: number }> }) {
  return [...result.scored].sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0))
}

describe('a frozen segment answers every read like the live partition it froze', () => {
  it('scores an exact term query identically', () => {
    const { live, frozen } = buildPair()
    const params = termParams({ tokens: ['apple'], exact: true })

    const liveResult = live.searchFulltext(params)
    const frozenResult = searchFulltext(frozen, params)

    expect(frozenResult.totalMatched).toBe(liveResult.totalMatched)
    expect(sortedByIdThenScore(frozenResult)).toEqual(sortedByIdThenScore(liveResult))
  })

  it('scores a multi-term query with termMatch all identically', () => {
    const { live, frozen } = buildPair()
    const params = termParams({ tokens: ['apple', 'common'], termMatch: 'all', exact: true })

    const liveResult = live.searchFulltext(params)
    const frozenResult = searchFulltext(frozen, params)

    expect(frozenResult.totalMatched).toBe(liveResult.totalMatched)
    expect(sortedByIdThenScore(frozenResult)).toEqual(sortedByIdThenScore(liveResult))
  })

  it('scores a fuzzy query identically at tolerance one and two', () => {
    const { live, frozen } = buildPair()
    for (const tolerance of [1, 2]) {
      for (const prefixLength of [0, 1, 2]) {
        const params = termParams({ tokens: ['appla'], tolerance, prefixLength })
        const liveResult = live.searchFulltext(params)
        const frozenResult = searchFulltext(frozen, params)
        expect(frozenResult.totalMatched).toBe(liveResult.totalMatched)
        expect(sortedByIdThenScore(frozenResult)).toEqual(sortedByIdThenScore(liveResult))
      }
    }
  })

  it('scores a prefix expansion identically', () => {
    const { live, frozen } = buildPair()

    const liveTerms = live.expandTermPrefix('appl', 'appl', 50)
    const frozenTerms = expandTermPrefix(frozen, 'appl', 'appl', 50)
    expect([...frozenTerms].sort()).toEqual([...liveTerms].sort())

    const params = termParams({
      tokens: ['appl'],
      prefixExpansion: { token: 'appl', terms: liveTerms.filter(term => term !== 'appl') },
    })
    const liveResult = live.searchFulltext(params)
    const frozenResult = searchFulltext(frozen, params)
    expect(frozenResult.totalMatched).toBe(liveResult.totalMatched)
    expect(sortedByIdThenScore(frozenResult)).toEqual(sortedByIdThenScore(liveResult))
  })

  it('serves the pruned single-term page identically', () => {
    const { live, frozen } = buildPair()
    const params = termParams({ tokens: ['apple'], collectComponents: false, maxResults: 10 })

    const liveResult = live.searchFulltext(params)
    const frozenResult = searchFulltext(frozen, params)

    expect(frozenResult.totalMatched).toBe(liveResult.totalMatched)
    expect(frozenResult.scored.map(doc => [doc.docId, doc.score])).toEqual(
      liveResult.scored.map(doc => [doc.docId, doc.score]),
    )
  })

  it('marks the same matching documents', () => {
    const { live, frozen } = buildPair()
    const params = termParams({ tokens: ['apple', 'banana'], exact: true })

    const liveMatches = live.searchFulltextMatches(params)
    const frozenMatches = searchFulltextMatches(frozen, params)

    expect(frozenMatches.count).toBe(liveMatches.count)
    expect(frozenMatches.matchedDocIds()).toEqual(liveMatches.matchedDocIds())
  })

  it('filters identically across numeric, boolean, and enum fields', () => {
    const { live, frozen } = buildPair()
    const filters = {
      fields: {
        price: { between: [2, 7] as [number, number] },
        active: { eq: true },
        category: { in: ['fruit', 'stone'] },
      },
    }

    expect(applyPartitionFilters(frozen, filters, simpleSchema)).toEqual(live.applyFilters(filters, simpleSchema))

    const liveMatches = live.filterMatches(filters, simpleSchema)
    const frozenMatches = partitionFilterMatches(frozen, filters, simpleSchema)
    expect(frozenMatches.count).toBe(liveMatches.count)
    for (const docId of applyPartitionFilters(frozen, filters, simpleSchema)) {
      expect(frozenMatches.hasExternal(docId)).toBe(true)
    }
  })

  it('combines filters with search through the same ordinal bitset', () => {
    const { live, frozen } = buildPair()
    const filters = { fields: { price: { gte: 5 } } }

    const liveResult = live.searchFulltext(
      termParams({ tokens: ['apple'], exact: true, filterBitset: live.applyFiltersBitset(filters, simpleSchema) }),
    )
    const frozenResult = searchFulltext(
      frozen,
      termParams({
        tokens: ['apple'],
        exact: true,
        filterBitset: live.applyFiltersBitset(filters, simpleSchema),
      }),
    )

    expect(frozenResult.totalMatched).toBe(liveResult.totalMatched)
    expect(sortedByIdThenScore(frozenResult)).toEqual(sortedByIdThenScore(liveResult))
  })

  it('counts facets identically', () => {
    const { live, frozen } = buildPair()
    const allIds = getAllDocIds(frozen.docStore)

    const liveFacets = live.computeFacets(allIds, { category: {}, active: {} }, simpleSchema)
    const frozenFacets = computeFacets(frozen, allIds, { category: {}, active: {} }, simpleSchema)

    expect(frozenFacets).toEqual(liveFacets)
  })

  it('suggests the same terms with the same counts', () => {
    const { live, frozen } = buildPair()

    const liveSuggestions = live.suggestTerms('app', 'app', 10)
    const frozenSuggestions = suggestDisplayTerms(frozen, 'app', 'app', 10)

    expect(frozenSuggestions).toEqual(liveSuggestions)
  })

  it('serves the same sorted page and sort values', () => {
    const { live, frozen, documents } = buildPair()
    const request = {
      fields: ['price', 'id'],
      directions: ['asc', 'asc'] as const,
      fieldTypes: ['number', 'string'] as const,
      limit: 25,
      anchorKey: null,
      anchorId: null,
      matches: null,
    }

    const livePage = live.sortedPage(request)
    const frozenPage = sortedPageOf(frozen, request)
    expect(frozenPage).toEqual(livePage)

    const probe = String(documents[7].id)
    expect(sortValuesOf(frozen, probe, ['price'], ['number'])).toEqual(live.sortValues(probe, ['price'], ['number']))
  })

  it('reads documents and counts identically', () => {
    const { live, frozen, documents } = buildPair()

    expect(frozen.docStore.count()).toBe(live.count())
    const probe = String(documents[11].id)
    expect(frozen.docStore.get(probe)?.fields).toEqual(live.getRef(probe))
    expect(frozen.docStore.has('missing')).toBe(false)
    expect([...frozen.docStore.sortedDocIds()]).toEqual([...live.sortedDocIds()])
  })
})

describe('a tombstone removes a document from every frozen read', () => {
  it('hides the document from search, filters, sorting, and document reads', () => {
    const { frozen, documents } = buildPair()
    const victim = String(documents[0].id)

    expect(frozen.tombstoneDocument(victim)).toBe(true)
    expect(frozen.tombstoneDocument(victim)).toBe(false)

    expect(frozen.docStore.has(victim)).toBe(false)
    expect(frozen.docStore.get(victim)).toBeUndefined()
    expect(frozen.docStore.count()).toBe(documents.length - 1)
    expect(frozen.liveDocumentCount()).toBe(documents.length - 1)

    const search = searchFulltext(frozen, termParams({ tokens: ['apple'], exact: true }))
    expect(search.scored.some(doc => doc.docId === victim)).toBe(false)

    const pruned = searchFulltext(
      frozen,
      termParams({ tokens: ['apple'], collectComponents: false, maxResults: documents.length }),
    )
    expect(pruned.scored.some(doc => doc.docId === victim)).toBe(false)

    const matches = searchFulltextMatches(frozen, termParams({ tokens: ['apple'], exact: true }))
    expect(matches.matchedDocIds().has(victim)).toBe(false)

    const filtered = applyPartitionFilters(frozen, { fields: { price: { gte: 0 } } }, simpleSchema)
    expect(filtered.has(victim)).toBe(false)

    const page = sortedPageOf(frozen, {
      fields: ['price'],
      directions: ['asc'] as const,
      fieldTypes: ['number'] as const,
      limit: documents.length,
      anchorKey: null,
      anchorId: null,
      matches: null,
    })
    expect(page.some(entry => entry.id === victim)).toBe(false)
    expect(page.length).toBe(documents.length - 1)

    expect([...frozen.docStore.sortedDocIds()]).not.toContain(victim)
  })

  it('keeps every other document intact after a tombstone', () => {
    const { live, frozen, documents } = buildPair()
    const victim = String(documents[30].id)
    frozen.tombstoneDocument(victim)

    const liveResult = live.searchFulltext(termParams({ tokens: ['banana'], exact: true }))
    const frozenResult = searchFulltext(frozen, termParams({ tokens: ['banana'], exact: true }))

    const liveIds = new Set(liveResult.scored.map(doc => doc.docId))
    liveIds.delete(victim)
    const frozenIds = new Set(frozenResult.scored.map(doc => doc.docId))
    expect(frozenIds).toEqual(liveIds)
  })

  it('encodes a partition that removed documents into a segment with compact ordinals', () => {
    const documents = buildCorpus(9)
    const live = createPartitionIndex(0)
    for (const doc of documents) {
      live.insert(String(doc.id), doc, simpleSchema, english, { collectSurfaces: true })
    }
    const removed = [String(documents[2].id), String(documents[5].id)]
    for (const docId of removed) {
      live.remove(docId, simpleSchema, english)
    }
    const survivors = documents.filter(doc => !removed.includes(String(doc.id)))

    const payload = live.encodeSegment()
    expect(payload.documentCount).toBe(survivors.length)
    expect(payload.docIds).toEqual(survivors.map(doc => String(doc.id)))
    for (const ordinal of payload.postingDocIds) {
      expect(ordinal).toBeLessThan(survivors.length)
    }
    expect(payload.docFrequencies).toEqual(live.stats.docFrequencies)
    expect(payload.totalFieldLengths).toEqual(live.stats.totalFieldLengths)

    const frozen = createFrozenSegment(payload, survivors)
    for (const params of [
      termParams({ tokens: ['banana'], exact: true }),
      termParams({ tokens: ['apple'], exact: true }),
    ]) {
      const liveResult = live.searchFulltext(params)
      const frozenResult = searchFulltext(frozen, params)
      expect(frozenResult.scored.map(doc => [doc.docId, doc.score])).toEqual(
        liveResult.scored.map(doc => [doc.docId, doc.score]),
      )
    }

    const filters = { fields: { price: { between: [0, 9] as [number, number] } } }
    expect(applyPartitionFilters(frozen, filters, simpleSchema)).toEqual(live.applyFilters(filters, simpleSchema))
    for (const doc of survivors) {
      expect(frozen.docStore.get(String(doc.id))?.fields).toEqual(doc)
    }
    for (const docId of removed) {
      expect(frozen.docStore.has(docId)).toBe(false)
    }
  })
})
