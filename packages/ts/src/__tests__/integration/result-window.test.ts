import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { AnyDocument, SchemaDefinition } from '../../types/schema'
import type { QueryParams } from '../../types/search'

const schema: SchemaDefinition = {
  title: 'string',
  category: 'enum',
  rank: 'number',
}

const CATEGORIES = ['electronics', 'books', 'clothing']
const CORPUS_SIZE = 1_200
const BETA_INTERVAL = 4
const SINGLE_PARTITION = 'catalogue'
const MANY_PARTITIONS = 'catalogue-split'

interface SeedDocument extends AnyDocument {
  id: string
  title: string
  category: string
  rank: number
}

function corpus(): SeedDocument[] {
  const documents: SeedDocument[] = []
  for (let i = 0; i < CORPUS_SIZE; i++) {
    const carriesBeta = i % BETA_INTERVAL !== 0
    documents.push({
      id: `doc-${String(i).padStart(5, '0')}`,
      title: carriesBeta ? `alpha beta item ${i}` : `alpha item ${i}`,
      category: CATEGORIES[i % CATEGORIES.length],
      rank: (i * 7) % CORPUS_SIZE,
    })
  }
  return documents
}

const documents = corpus()
const alphaIds = documents.map(doc => doc.id)
const betaIds = documents.filter((_, i) => i % BETA_INTERVAL !== 0).map(doc => doc.id)

function categoryCounts(ids: string[]): Record<string, number> {
  const byId = new Map(documents.map(doc => [doc.id, doc]))
  const counts: Record<string, number> = {}
  for (const id of ids) {
    const category = byId.get(id)?.category
    if (category === undefined) continue
    counts[category] = (counts[category] ?? 0) + 1
  }
  return counts
}

function idsByRankThenId(): string[] {
  return documents
    .slice()
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(doc => doc.id)
}

async function walkWithCursor(
  narsil: Narsil,
  indexName: string,
  params: QueryParams,
  pageSize: number,
): Promise<string[]> {
  const seen: string[] = []
  let cursor: string | undefined
  for (let page = 0; page <= Math.ceil(CORPUS_SIZE / pageSize) + 1; page++) {
    const result = await narsil.query(indexName, { ...params, limit: pageSize, searchAfter: cursor })
    for (const hit of result.hits) seen.push(hit.id)
    if (result.cursor === undefined) return seen
    cursor = result.cursor
  }
  throw new Error('the cursor walk did not finish')
}

describe('a match set larger than one page', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex(SINGLE_PARTITION, { schema, language: 'english' })
    await narsil.insertBatch(SINGLE_PARTITION, documents)
    await narsil.createIndex(MANY_PARTITIONS, {
      schema,
      language: 'english',
      partitions: { maxDocsPerPartition: 400, maxPartitions: 8, watermark: 0.9 },
    })
    await narsil.insertBatch(MANY_PARTITIONS, documents)
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('counts every match, whatever the query carries', async () => {
    for (const indexName of [SINGLE_PARTITION, MANY_PARTITIONS]) {
      const plain = await narsil.query(indexName, { term: 'alpha' })
      expect(plain.count).toBe(CORPUS_SIZE)

      const sorted = await narsil.query(indexName, { term: 'alpha', sort: { rank: 'asc' } })
      expect(sorted.count).toBe(CORPUS_SIZE)

      const grouped = await narsil.query(indexName, {
        term: 'alpha',
        group: { fields: ['category'], maxPerGroup: 2 },
      })
      expect(grouped.count).toBe(CORPUS_SIZE)

      const everyTerm = await narsil.query(indexName, { term: 'alpha beta', termMatch: 'all' })
      expect(everyTerm.count).toBe(betaIds.length)

      const aboveThreshold = await narsil.query(indexName, { term: 'beta', minScore: 0.000001 })
      expect(aboveThreshold.count).toBe(betaIds.length)
    }
  })

  it('walks every match once with a cursor, sorted and unsorted', async () => {
    for (const indexName of [SINGLE_PARTITION, MANY_PARTITIONS]) {
      const unsorted = await walkWithCursor(narsil, indexName, { term: 'alpha' }, 250)
      expect(unsorted).toHaveLength(CORPUS_SIZE)
      expect(new Set(unsorted).size).toBe(CORPUS_SIZE)
      expect(unsorted.slice().sort()).toEqual(alphaIds.slice().sort())

      const sorted = await walkWithCursor(narsil, indexName, { term: 'alpha', sort: { rank: 'asc' } }, 250)
      expect(sorted).toEqual(idsByRankThenId())
    }
  })

  it('counts facets over every match rather than over the page', async () => {
    for (const indexName of [SINGLE_PARTITION, MANY_PARTITIONS]) {
      const result = await narsil.query(indexName, { term: 'alpha', limit: 10, facets: { category: {} } })
      expect(result.hits).toHaveLength(10)
      expect(result.facets?.category.values).toEqual(categoryCounts(alphaIds))

      const filtered = await narsil.query(indexName, { term: 'beta', limit: 5, facets: { category: {} } })
      expect(filtered.facets?.category.values).toEqual(categoryCounts(betaIds))
    }
  })

  it('refuses a page reaching past the result window', async () => {
    const atTheEdge = await narsil.query(SINGLE_PARTITION, { term: 'alpha', limit: 5, offset: 9_995 })
    expect(atTheEdge.hits).toEqual([])
    expect(atTheEdge.count).toBe(CORPUS_SIZE)

    await expect(narsil.query(SINGLE_PARTITION, { term: 'alpha', limit: 6, offset: 9_995 })).rejects.toMatchObject({
      code: 'SEARCH_RESULT_WINDOW_EXCEEDED',
    })
    await expect(narsil.listDocuments(SINGLE_PARTITION, { limit: 10_001 })).rejects.toMatchObject({
      code: 'SEARCH_RESULT_WINDOW_EXCEEDED',
    })
  })

  it('orders by an all-digit field name given as a list', async () => {
    await narsil.createIndex('yearly', { schema: { title: 'string', 2024: 'number' }, language: 'english' })
    await narsil.insertBatch('yearly', [
      { id: 'low', title: 'alpha one', 2024: 1 },
      { id: 'high', title: 'alpha two', 2024: 9 },
    ])

    const descending = await narsil.query('yearly', {
      term: 'alpha',
      sort: [{ field: '2024', direction: 'desc' }],
    })
    expect(descending.hits.map(hit => hit.id)).toEqual(['high', 'low'])

    const ascending = await narsil.query('yearly', {
      term: 'alpha',
      sort: [{ field: '2024', direction: 'asc' }],
    })
    expect(ascending.hits.map(hit => hit.id)).toEqual(['low', 'high'])
  })
})
