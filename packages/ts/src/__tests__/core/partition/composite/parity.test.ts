import { describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../../../core/partition'
import { type CompositePartition, createCompositePartition } from '../../../../core/partition/composite'
import { ErrorCodes, NarsilError } from '../../../../errors'
import type { InternalSearchParams } from '../../../../types/internal'
import type { AnyDocument } from '../../../../types/schema'
import { english, simpleSchema } from '../../partition-index/fixtures'

const CATEGORIES = ['fruit', 'metal', 'stone'] as const
const WORDS = ['apple', 'apply', 'appli', 'banana', 'copper', 'quartz']

function buildCorpus(count: number): AnyDocument[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${String(i).padStart(3, '0')}`,
    title: `${WORDS[i % WORDS.length]} ${WORDS[(i + 1) % WORDS.length]}`,
    body: `${WORDS[i % 2]} common ${'apple '.repeat((i % 3) + 1).trim()}`,
    price: i % 10,
    active: i % 2 === 0,
    category: CATEGORIES[i % CATEGORIES.length],
  }))
}

function frozenPayloadFor(documents: AnyDocument[]): ReturnType<PartitionIndex['encodeSegment']> {
  const scratch = createPartitionIndex(0)
  for (const doc of documents) {
    scratch.insert(String(doc.id), doc, simpleSchema, english, { collectSurfaces: true })
  }
  return scratch.encodeSegment()
}

function buildPair(
  count = 160,
  frozenSegments = 3,
): { baseline: PartitionIndex; composite: CompositePartition; documents: AnyDocument[] } {
  const documents = buildCorpus(count)
  const baseline = createPartitionIndex(0)
  for (const doc of documents) {
    baseline.insert(String(doc.id), doc, simpleSchema, english, { collectSurfaces: true })
  }

  const composite = createCompositePartition(0)
  const perSegment = Math.floor(count / (frozenSegments + 1))
  for (let s = 0; s < frozenSegments; s++) {
    const chunk = documents.slice(s * perSegment, (s + 1) * perSegment)
    composite.appendFrozenSegment(frozenPayloadFor(chunk), chunk)
  }
  for (const doc of documents.slice(frozenSegments * perSegment)) {
    composite.insert(String(doc.id), doc, simpleSchema, english, { collectSurfaces: true })
  }

  return { baseline, composite, documents }
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

function byId(result: { scored: Array<{ docId: string; score: number }> }): Array<[string, number]> {
  return result.scored
    .map((doc): [string, number] => [doc.docId, doc.score])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

describe('a composite of frozen segments plus a live tail matches one merged partition', () => {
  it('scores exact, multi-term, and coverage-filtered queries identically', () => {
    const { baseline, composite } = buildPair()

    for (const params of [
      termParams({ tokens: ['apple'], exact: true }),
      termParams({ tokens: ['apple', 'common'], exact: true }),
      termParams({ tokens: ['apple', 'banana'], termMatch: 'all', exact: true }),
    ]) {
      const base = baseline.searchFulltext(params)
      const fanned = composite.searchFulltext(params)
      expect(fanned.totalMatched).toBe(base.totalMatched)
      expect(byId(fanned)).toEqual(byId(base))
    }
  })

  it('scores fuzzy queries identically because term frequencies aggregate across segments', () => {
    const { baseline, composite } = buildPair()

    for (const tolerance of [1, 2]) {
      for (const prefixLength of [0, 1, 2]) {
        const params = termParams({ tokens: ['appla'], tolerance, prefixLength })
        const base = baseline.searchFulltext(params)
        const fanned = composite.searchFulltext(params)
        expect(fanned.totalMatched).toBe(base.totalMatched)

        const baseById = byId(base)
        const fannedById = byId(fanned)
        expect(fannedById.map(entry => entry[0])).toEqual(baseById.map(entry => entry[0]))
        for (let i = 0; i < baseById.length; i++) {
          expect(fannedById[i][1]).toBeCloseTo(baseById[i][1], 12)
        }
      }
    }
  })

  it('expands and scores a prefix identically', () => {
    const { baseline, composite } = buildPair()

    const baseTerms = baseline.expandTermPrefix('appl', 'appl', 50)
    const fannedTerms = composite.expandTermPrefix('appl', 'appl', 50)
    expect([...fannedTerms].sort()).toEqual([...baseTerms].sort())

    const params = termParams({
      tokens: ['appl'],
      prefixExpansion: { token: 'appl', terms: baseTerms.filter(term => term !== 'appl') },
    })
    const base = baseline.searchFulltext(params)
    const fanned = composite.searchFulltext(params)
    expect(fanned.totalMatched).toBe(base.totalMatched)
    expect(byId(fanned)).toEqual(byId(base))
  })

  it('returns the same truncated page for a limited query', () => {
    const { baseline, composite } = buildPair()
    const params = termParams({ tokens: ['apple'], collectComponents: false, maxResults: 10 })

    const base = baseline.searchFulltext(params)
    const fanned = composite.searchFulltext(params)

    expect(fanned.totalMatched).toBe(base.totalMatched)
    expect(fanned.scored.map(doc => [doc.docId, doc.score])).toEqual(base.scored.map(doc => [doc.docId, doc.score]))
  })

  it('combines its own filter bitset with search identically', () => {
    const { baseline, composite } = buildPair()
    const filters = { fields: { price: { gte: 5 } } }

    const base = baseline.searchFulltext(
      termParams({ tokens: ['apple'], exact: true, filterBitset: baseline.applyFiltersBitset(filters, simpleSchema) }),
    )
    const fanned = composite.searchFulltext(
      termParams({
        tokens: ['apple'],
        exact: true,
        filterBitset: composite.applyFiltersBitset(filters, simpleSchema),
      }),
    )

    expect(fanned.totalMatched).toBe(base.totalMatched)
    expect(byId(fanned)).toEqual(byId(base))
  })

  it('filters, matches, and facets identically', () => {
    const { baseline, composite } = buildPair()
    const filters = {
      fields: {
        price: { between: [2, 7] as [number, number] },
        active: { eq: true },
        category: { in: ['fruit', 'stone'] },
      },
    }

    expect(composite.applyFilters(filters, simpleSchema)).toEqual(baseline.applyFilters(filters, simpleSchema))
    expect(composite.filterMatches(filters, simpleSchema).count).toBe(
      baseline.filterMatches(filters, simpleSchema).count,
    )

    const params = termParams({ tokens: ['apple', 'banana'], exact: true })
    const baseMatches = baseline.searchFulltextMatches(params)
    const fannedMatches = composite.searchFulltextMatches(params)
    expect(fannedMatches.count).toBe(baseMatches.count)
    expect(fannedMatches.matchedDocIds()).toEqual(baseMatches.matchedDocIds())

    const allIds = new Set([...composite.docIds()])
    expect(composite.computeFacets(allIds, { category: {}, active: {} }, simpleSchema)).toEqual(
      baseline.computeFacets(allIds, { category: {}, active: {} }, simpleSchema),
    )
  })

  it('serves the same sorted pages, including anchored paging', () => {
    const { baseline, composite } = buildPair()
    const request = {
      fields: ['price', 'id'],
      directions: ['asc', 'asc'] as const,
      fieldTypes: ['number', 'string'] as const,
      limit: 20,
      anchorKey: null,
      anchorId: null,
      matches: null,
    }

    const basePage = baseline.sortedPage(request)
    const fannedPage = composite.sortedPage(request)
    expect(fannedPage).toEqual(basePage)

    const anchor = basePage[basePage.length - 1]
    const anchored = { ...request, anchorKey: anchor.key, anchorId: anchor.id }
    expect(composite.sortedPage(anchored)).toEqual(baseline.sortedPage(anchored))
  })

  it('suggests the same terms and reads the same documents', () => {
    const { baseline, composite, documents } = buildPair()

    expect(composite.suggestTerms('app', 'app', 10)).toEqual(baseline.suggestTerms('app', 'app', 10))

    expect(composite.count()).toBe(baseline.count())
    const probe = String(documents[11].id)
    expect(composite.get(probe)).toEqual(baseline.get(probe))
    expect(composite.has(probe)).toBe(true)
    expect([...composite.sortedDocIds()]).toEqual([...baseline.sortedDocIds()])
    expect(composite.sortValues(probe, ['price'], ['number'])).toEqual(
      baseline.sortValues(probe, ['price'], ['number']),
    )
  })
})

describe('composite writes route to the owning part', () => {
  it('removes a frozen document by tombstone and a live document directly', () => {
    const { composite, documents } = buildPair()
    const frozenVictim = String(documents[0].id)
    const liveVictim = String(documents[documents.length - 1].id)

    composite.remove(frozenVictim, simpleSchema, english)
    composite.remove(liveVictim, simpleSchema, english)

    expect(composite.has(frozenVictim)).toBe(false)
    expect(composite.has(liveVictim)).toBe(false)
    expect(composite.count()).toBe(documents.length - 2)

    const result = composite.searchFulltext(termParams({ tokens: ['apple'], exact: true }))
    expect(result.scored.some(doc => doc.docId === frozenVictim)).toBe(false)
    expect(result.scored.some(doc => doc.docId === liveVictim)).toBe(false)

    expect(() => composite.remove('missing', simpleSchema, english)).toThrow(NarsilError)
  })

  it('updates a frozen document by tombstoning and reinserting into the live tail', () => {
    const { composite, documents } = buildPair()
    const target = String(documents[1].id)
    const replacement = { ...documents[1], title: 'zebra unique', price: 99 }

    composite.update(target, replacement, simpleSchema, english)

    expect(composite.count()).toBe(documents.length)
    expect(composite.get(target)).toMatchObject({ title: 'zebra unique', price: 99 })

    const found = composite.searchFulltext(termParams({ tokens: ['zebra'], exact: true }))
    expect(found.scored.some(doc => doc.docId === target)).toBe(true)

    const filtered = composite.applyFilters({ fields: { price: { eq: 99 } } }, simpleSchema)
    expect(filtered.has(target)).toBe(true)
  })

  it('rejects an insert whose id already lives in a frozen segment', () => {
    const { composite, documents } = buildPair()
    const taken = String(documents[2].id)

    try {
      composite.insert(taken, { id: taken, title: 'dup' }, simpleSchema, english)
      expect.unreachable('insert should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.DOC_ALREADY_EXISTS)
    }
  })
})
