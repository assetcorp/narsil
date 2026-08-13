import { describe, expect, it } from 'vitest'
import { createPartitionIndex } from '../../../../core/partition'
import { applyPartitionFilters } from '../../../../core/partition/filters'
import {
  createFrozenSegment,
  createSharedFrozenSegment,
  type FrozenSegment,
  freezeSegmentShared,
} from '../../../../core/partition/frozen'
import { searchFulltextMatches } from '../../../../core/partition/matches'
import { searchFulltext } from '../../../../core/partition/search'
import { sortedPageOf } from '../../../../core/partition/sorting'
import { expandTermPrefix, suggestDisplayTerms } from '../../../../core/partition/suggestions'
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

function buildTriple(count = 120): { plain: FrozenSegment; shared: FrozenSegment; documents: AnyDocument[] } {
  const documents = buildCorpus(count)
  const live = createPartitionIndex(0)
  for (const doc of documents) {
    live.insert(String(doc.id), doc, simpleSchema, english, { collectSurfaces: true })
  }
  const payload = live.encodeSegment()
  const snapshot = freezeSegmentShared(payload, documents)
  if (snapshot === null) throw new Error('SharedArrayBuffer is unavailable in this runtime')
  return {
    plain: createFrozenSegment(payload, documents),
    shared: createSharedFrozenSegment(snapshot),
    documents,
  }
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

describe('a shared frozen segment answers every read like its plain twin', () => {
  it('is backed by SharedArrayBuffers end to end', () => {
    const documents = buildCorpus(40)
    const live = createPartitionIndex(0)
    for (const doc of documents) {
      live.insert(String(doc.id), doc, simpleSchema, english)
    }
    const snapshot = freezeSegmentShared(live.encodeSegment(), documents)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return

    const buffers = [
      snapshot.postingOffsets,
      snapshot.postingDocIds,
      snapshot.postingFrequencies,
      snapshot.postingFieldIndices,
      snapshot.tokenTable.blob,
      snapshot.tokenTable.offsets,
      snapshot.tokenTable.payloadSlots,
      snapshot.tokenTable.documentFrequencies,
      snapshot.idTable.blob,
      snapshot.idTable.offsets,
      snapshot.idTable.sortedOrdinals,
      snapshot.documentTable.blob,
      snapshot.documentTable.offsets,
      ...snapshot.fieldLengthColumns,
      ...snapshot.numeric.flatMap(entry => [entry.docIds, entry.values]),
      ...snapshot.boolean.flatMap(entry => [entry.trueDocs, entry.falseDocs]),
      ...snapshot.enums.flatMap(entry => [entry.offsets, entry.docIds]),
    ]
    for (const view of buffers) {
      expect(view.buffer).toBeInstanceOf(SharedArrayBuffer)
    }
  })

  it('searches exactly, fuzzily, and by prefix with identical scores', () => {
    const { plain, shared } = buildTriple()

    const cases = [
      termParams({ tokens: ['apple'], exact: true }),
      termParams({ tokens: ['appla'], tolerance: 1 }),
      termParams({ tokens: ['appla'], tolerance: 2, prefixLength: 1 }),
      termParams({ tokens: ['apple'], collectComponents: false, maxResults: 10 }),
    ]
    for (const params of cases) {
      const plainResult = searchFulltext(plain, params)
      const sharedResult = searchFulltext(shared, params)
      expect(sharedResult.totalMatched).toBe(plainResult.totalMatched)
      expect(sharedResult.scored.map(d => [d.docId, d.score])).toEqual(plainResult.scored.map(d => [d.docId, d.score]))
    }

    expect(expandTermPrefix(shared, 'appl', 'appl', 50).sort()).toEqual(
      expandTermPrefix(plain, 'appl', 'appl', 50).sort(),
    )
    expect(suggestDisplayTerms(shared, 'app', 'app', 10)).toEqual(suggestDisplayTerms(plain, 'app', 'app', 10))
  })

  it('matches, filters, sorts, and reads documents identically', () => {
    const { plain, shared, documents } = buildTriple()

    const matchParams = termParams({ tokens: ['apple', 'banana'], exact: true })
    expect(searchFulltextMatches(shared, matchParams).matchedDocIds()).toEqual(
      searchFulltextMatches(plain, matchParams).matchedDocIds(),
    )

    const filters = {
      fields: {
        price: { between: [2, 7] as [number, number] },
        active: { eq: true },
        category: { in: ['fruit', 'stone'] },
      },
    }
    expect(applyPartitionFilters(shared, filters, simpleSchema)).toEqual(
      applyPartitionFilters(plain, filters, simpleSchema),
    )

    const request = {
      fields: ['price', 'id'],
      directions: ['asc', 'asc'] as const,
      fieldTypes: ['number', 'string'] as const,
      limit: 25,
      anchorKey: null,
      anchorId: null,
      matches: null,
    }
    expect(sortedPageOf(shared, request)).toEqual(sortedPageOf(plain, request))

    expect(shared.docStore.count()).toBe(plain.docStore.count())
    const probe = String(documents[11].id)
    expect(shared.docStore.get(probe)?.fields).toEqual(plain.docStore.get(probe)?.fields)
    expect([...shared.docStore.sortedDocIds()]).toEqual([...plain.docStore.sortedDocIds()])
    expect(shared.stats.docFrequencies).toEqual(plain.stats.docFrequencies)
  })

  it('hides a tombstoned document from shared reads', () => {
    const { shared, documents } = buildTriple()
    const victim = String(documents[0].id)

    expect(shared.tombstoneDocument(victim)).toBe(true)
    expect(shared.docStore.has(victim)).toBe(false)
    expect(shared.liveDocumentCount()).toBe(documents.length - 1)

    const result = searchFulltext(shared, termParams({ tokens: ['apple'], exact: true }))
    expect(result.scored.some(doc => doc.docId === victim)).toBe(false)
    expect([...shared.docStore.sortedDocIds()]).not.toContain(victim)
  })
})
