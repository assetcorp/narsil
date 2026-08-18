import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { QueryResult } from '../../types/results'
import type { SchemaDefinition } from '../../types/schema'

const schema: SchemaDefinition = {
  title: 'string:sortable',
  body: 'string',
  rank: 'number',
  genre: 'enum',
}

interface Seed {
  id: string
  title: string
  body: string
  rank: number
  genre: string
}

const catalogue: Seed[] = [
  { id: 'd01', title: 'delta', body: 'searchable text about engines', rank: 30, genre: 'drama' },
  { id: 'd02', title: 'alpha', body: 'searchable text about engines', rank: 10, genre: 'comedy' },
  { id: 'd03', title: 'charlie', body: 'searchable text about pistons', rank: 20, genre: 'drama' },
  { id: 'd04', title: 'bravo', body: 'searchable text about engines', rank: 40, genre: 'comedy' },
  { id: 'd05', title: 'echo', body: 'searchable text about pistons', rank: 20, genre: 'drama' },
  { id: 'd06', title: 'foxtrot', body: 'unrelated cooking recipe', rank: 5, genre: 'comedy' },
  { id: 'd07', title: 'golf', body: 'searchable notes about engines', rank: 25, genre: 'drama' },
  { id: 'd08', title: 'hotel', body: 'searchable notes about engines', rank: 15, genre: 'comedy' },
  { id: 'd09', title: 'india', body: 'searchable notes about pistons', rank: 35, genre: 'drama' },
  { id: 'd10', title: 'juliet', body: 'searchable notes about engines', rank: 45, genre: 'comedy' },
]

async function seed(narsil: Narsil, indexName: string): Promise<void> {
  for (const entry of catalogue) {
    await narsil.insert(
      indexName,
      { title: entry.title, body: entry.body, rank: entry.rank, genre: entry.genre },
      entry.id,
    )
  }
}

function searchableIdsByRank(): string[] {
  return catalogue
    .filter(entry => entry.body.includes('searchable'))
    .slice()
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1))
    .map(entry => entry.id)
}

describe('a sorted query', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('docs', {
      schema,
      language: 'english',
      partitions: { maxDocsPerPartition: 4, maxPartitions: 3 },
    })
    await seed(narsil, 'docs')
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('orders hits by the sort field and carries no scores', async () => {
    const result = await narsil.query('docs', { term: 'searchable', sort: { rank: 'asc' }, limit: 20 })
    expect(result.hits.map(hit => hit.id)).toEqual(searchableIdsByRank())
    for (const hit of result.hits) {
      expect(hit.score).toBeUndefined()
    }
  })

  it('reports the same match count as the unsorted query', async () => {
    const sorted = await narsil.query('docs', { term: 'searchable', sort: { rank: 'asc' } })
    const unsorted = await narsil.query('docs', { term: 'searchable' })
    expect(sorted.count).toBe(unsorted.count)
    expect(sorted.count).toBe(9)
  })

  it('restores scores under includeScores and keeps the sort order', async () => {
    const unsorted = await narsil.query('docs', { term: 'searchable', limit: 20 })
    const scoreById = new Map(unsorted.hits.map(hit => [hit.id, hit.score]))

    const sorted = await narsil.query('docs', {
      term: 'searchable',
      sort: { rank: 'asc' },
      includeScores: true,
      limit: 20,
    })
    expect(sorted.hits.map(hit => hit.id)).toEqual(searchableIdsByRank())
    for (const hit of sorted.hits) {
      expect(hit.score).toBeCloseTo(scoreById.get(hit.id) ?? Number.NaN, 10)
    }
  })

  it('orders descending and breaks rank ties on document id', async () => {
    const result = await narsil.query('docs', { term: 'pistons', sort: { rank: 'desc' }, limit: 20 })
    expect(result.hits.map(hit => hit.id)).toEqual(['d09', 'd03', 'd05'])
  })

  it('pages with the cursor without duplicating or dropping a hit', async () => {
    const wholePage = await narsil.query('docs', { term: 'searchable', sort: { rank: 'asc' }, limit: 20 })

    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page: QueryResult = await narsil.query('docs', {
        term: 'searchable',
        sort: { rank: 'asc' },
        limit: 2,
        searchAfter: cursor,
      })
      for (const hit of page.hits) seen.push(hit.id)
      if (page.cursor === undefined) break
      cursor = page.cursor
    }

    expect(seen).toEqual(wholePage.hits.map(hit => hit.id))
  })

  it('applies an offset the way the full page slices', async () => {
    const wholePage = await narsil.query('docs', { term: 'searchable', sort: { rank: 'asc' }, limit: 20 })
    const offsetPage = await narsil.query('docs', { term: 'searchable', sort: { rank: 'asc' }, offset: 3, limit: 2 })
    expect(offsetPage.hits.map(hit => hit.id)).toEqual(wholePage.hits.slice(3, 5).map(hit => hit.id))
  })

  it('narrows to the filter before selecting the page', async () => {
    const result = await narsil.query('docs', {
      term: 'searchable',
      filters: { fields: { genre: { eq: 'drama' } } },
      sort: { rank: 'asc' },
      limit: 20,
    })
    expect(result.hits.map(hit => hit.id)).toEqual(['d03', 'd05', 'd07', 'd01', 'd09'])
    expect(result.count).toBe(5)
  })

  it('counts facets over every match, not the returned page', async () => {
    const sorted = await narsil.query('docs', {
      term: 'searchable',
      sort: { rank: 'asc' },
      limit: 2,
      facets: { genre: {} },
    })
    const unsorted = await narsil.query('docs', { term: 'searchable', facets: { genre: {} } })
    expect(sorted.facets).toEqual(unsorted.facets)
  })

  it('matches the same documents as the unsorted query under fuzzy matching', async () => {
    const sorted = await narsil.query('docs', { term: 'searchible', tolerance: 1, sort: { rank: 'asc' }, limit: 20 })
    const unsorted = await narsil.query('docs', { term: 'searchible', tolerance: 1, limit: 20 })
    expect(new Set(sorted.hits.map(hit => hit.id))).toEqual(new Set(unsorted.hits.map(hit => hit.id)))
  })

  it('continues a page sequence when a later page asks for scores', async () => {
    const first = await narsil.query('docs', { term: 'searchable', sort: { rank: 'asc' }, limit: 3 })
    const second = await narsil.query('docs', {
      term: 'searchable',
      sort: { rank: 'asc' },
      limit: 3,
      searchAfter: first.cursor,
      includeScores: true,
    })
    const expected = searchableIdsByRank()
    expect(first.hits.map(hit => hit.id)).toEqual(expected.slice(0, 3))
    expect(second.hits.map(hit => hit.id)).toEqual(expected.slice(3, 6))
    for (const hit of second.hits) {
      expect(typeof hit.score).toBe('number')
    }
  })

  it('applies a score floor while still reporting no scores', async () => {
    const floored = await narsil.query('docs', {
      term: 'searchable',
      sort: { rank: 'asc' },
      minScore: 0.0001,
      limit: 20,
    })
    expect(floored.hits.map(hit => hit.id)).toEqual(searchableIdsByRank())
    for (const hit of floored.hits) {
      expect(hit.score).toBeUndefined()
    }
  })

  it('keeps grouping working and strips the scores from grouped hits', async () => {
    const result = await narsil.query('docs', {
      term: 'searchable',
      sort: { rank: 'asc' },
      group: { fields: ['genre'], maxPerGroup: 2 },
      limit: 20,
    })
    expect(result.groups).toBeDefined()
    for (const hit of result.hits) {
      expect(hit.score).toBeUndefined()
    }
    for (const group of result.groups ?? []) {
      for (const hit of group.hits) {
        expect(hit.score).toBeUndefined()
      }
    }
  })

  it('matches the same documents as the unsorted query under prefix matching', async () => {
    const sorted = await narsil.query('docs', { term: 'search', prefix: true, sort: { rank: 'asc' }, limit: 20 })
    const unsorted = await narsil.query('docs', { term: 'search', prefix: true, limit: 20 })
    expect(new Set(sorted.hits.map(hit => hit.id))).toEqual(new Set(unsorted.hits.map(hit => hit.id)))
    expect(sorted.hits.length).toBeGreaterThan(0)
  })

  it('returns score components under a sort without restoring the score', async () => {
    const result = await narsil.query('docs', {
      term: 'searchable',
      sort: { rank: 'asc' },
      includeScoreComponents: true,
      limit: 5,
    })
    for (const hit of result.hits) {
      expect(hit.score).toBeUndefined()
      expect(hit.scoreComponents).toBeDefined()
    }
  })

  it('leaves an unsorted query scoring as before', async () => {
    const result = await narsil.query('docs', { term: 'searchable' })
    expect(result.hits.length).toBeGreaterThan(0)
    for (const hit of result.hits) {
      expect(typeof hit.score).toBe('number')
    }
  })

  it('returns the stored documents on the sorted page', async () => {
    const result = await narsil.query('docs', { term: 'searchable', sort: { rank: 'asc' }, limit: 2 })
    expect(result.hits[0].document).toMatchObject({ title: 'alpha', rank: 10 })
  })

  it('matches nothing for a term absent from the index', async () => {
    const result = await narsil.query('docs', { term: 'zeppelin', sort: { rank: 'asc' } })
    expect(result.hits).toEqual([])
    expect(result.count).toBe(0)
    expect(result.cursor).toBeUndefined()
  })
})
