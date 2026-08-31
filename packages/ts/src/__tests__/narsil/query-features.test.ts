import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { FilterExpression } from '../../types/filters'
import { indexConfig } from './fixtures'

describe('Narsil query features', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  describe('the result window', () => {
    it('refuses a request reaching past the window and reads a negative offset as zero', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Test Item', category: 'test', price: 10 })

      await expect(narsil.query('products', { term: 'test', limit: 999999, offset: -5 })).rejects.toMatchObject({
        code: 'SEARCH_RESULT_WINDOW_EXCEEDED',
      })

      const atTheWindow = await narsil.query('products', { term: 'test', limit: 9_000, offset: 1_000 })
      expect(atTheWindow.count).toBe(1)

      const emptyPage = await narsil.query('products', { term: 'test', limit: -1 })
      expect(emptyPage.hits).toEqual([])
    })
  })

  describe('query with sorting', () => {
    it('sorts results by a numeric field', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Cheap Earbuds', category: 'electronics', price: 15 }, 'cheap')
      await narsil.insert('products', { title: 'Premium Earbuds', category: 'electronics', price: 200 }, 'premium')
      await narsil.insert('products', { title: 'Mid Earbuds', category: 'electronics', price: 75 }, 'mid')

      const result = await narsil.query('products', {
        term: 'earbuds',
        sort: { price: 'asc' },
      })

      expect(result.hits.length).toBe(3)
      const prices = result.hits.map(h => (h.document as Record<string, unknown>).price as number)
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1])
      }
    })
  })

  describe('query with grouping', () => {
    it('groups results by a field', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Wireless Mouse', category: 'electronics', price: 25 })
      await narsil.insert('products', { title: 'Wireless Keyboard', category: 'electronics', price: 45 })
      await narsil.insert('products', { title: 'Wireless Charger', category: 'accessories', price: 20 })

      const result = await narsil.query('products', {
        term: 'wireless',
        group: { fields: ['category'] },
      })

      expect(result.groups).toBeDefined()
      const groups = result.groups ?? []
      expect(groups.length).toBeGreaterThan(0)

      const groupValues = groups.map(g => g.values.category)
      expect(groupValues).toContain('electronics')
    })
  })

  describe('query with pagination and cursor', () => {
    it('paginates results using offset', async () => {
      await narsil.createIndex('products', indexConfig)

      for (let i = 0; i < 5; i++) {
        await narsil.insert('products', {
          title: `Wireless Device ${i}`,
          category: 'electronics',
          price: 10 + i,
        })
      }

      const page1 = await narsil.query('products', { term: 'wireless', limit: 2, offset: 0 })
      expect(page1.hits.length).toBe(2)
      expect(page1.count).toBe(5)

      const page2 = await narsil.query('products', { term: 'wireless', limit: 2, offset: 2 })
      expect(page2.hits.length).toBe(2)

      const page1Ids = new Set(page1.hits.map(h => h.id))
      for (const hit of page2.hits) {
        expect(page1Ids.has(hit.id)).toBe(false)
      }
    })

    it('returns a cursor when more results exist beyond the current page', async () => {
      await narsil.createIndex('products', indexConfig)

      for (let i = 0; i < 5; i++) {
        await narsil.insert('products', {
          title: `Wireless Device ${i}`,
          category: 'electronics',
          price: 10 + i,
        })
      }

      const result = await narsil.query('products', { term: 'wireless', limit: 2 })
      expect(result.hits.length).toBe(2)
      expect(result.cursor).toBeDefined()

      const lastPage = await narsil.query('products', { term: 'wireless', limit: 10 })
      expect(lastPage.cursor).toBeUndefined()
    })
  })

  describe('query with highlighting', () => {
    it('returns highlight snippets for matched terms', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', {
        title: 'Noise Cancelling Wireless Headphones',
        category: 'electronics',
        price: 199,
      })

      const result = await narsil.query('products', {
        term: 'wireless',
        highlight: { fields: ['title'] },
      })

      expect(result.hits.length).toBe(1)
      const highlights = result.hits[0].highlights
      expect(highlights).toBeDefined()
      expect(highlights?.title).toBeDefined()
      expect(highlights?.title.snippet).toContain('<mark>')
    })
  })

  describe('query with pinning', () => {
    it('pins a specific document at a given position', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert(
        'products',
        {
          title: 'Standard Headphones',
          category: 'electronics',
          price: 30,
        },
        'standard',
      )
      await narsil.insert(
        'products',
        {
          title: 'Premium Headphones Model',
          category: 'electronics',
          price: 250,
        },
        'premium',
      )
      await narsil.insert(
        'products',
        {
          title: 'Budget Headphones',
          category: 'electronics',
          price: 15,
        },
        'budget',
      )

      const result = await narsil.query('products', {
        term: 'headphones',
        pinned: [{ docId: 'budget', position: 0 }],
      })

      expect(result.hits.length).toBeGreaterThan(0)
      expect(result.hits[0].id).toBe('budget')
    })
  })

  describe('query with facets', () => {
    it('returns facet counts for a field', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'USB Cable', category: 'accessories', price: 5 })
      await narsil.insert('products', { title: 'USB Hub', category: 'electronics', price: 25 })
      await narsil.insert('products', { title: 'USB Charger', category: 'electronics', price: 15 })

      const result = await narsil.query('products', {
        term: 'usb',
        facets: { category: {} },
      })

      const facets = result.facets
      expect(facets).toBeDefined()
      expect(facets?.category).toBeDefined()
      expect(facets?.category.values).toBeDefined()
    })

    it('counts a value repeated inside one document array once', async () => {
      await narsil.createIndex('articles', { schema: { title: 'string', topics: 'enum[]', ratings: 'number[]' } })
      await narsil.insert('articles', { title: 'alpha piece', topics: ['news', 'news', 'sport'], ratings: [4, 4, 5] })
      await narsil.insert('articles', { title: 'alpha follow-up', topics: ['news'], ratings: [3] })

      const result = await narsil.query('articles', { term: 'alpha', facets: { topics: {}, ratings: {} } })

      expect(result.facets?.topics.values).toEqual({ news: 2, sport: 1 })
      expect(result.facets?.ratings.values).toEqual({ '4': 1, '5': 1, '3': 1 })
    })

    it('returns the same facet counts with and without a sort', async () => {
      await narsil.createIndex('articles', { schema: { title: 'string', topics: 'enum[]', rank: 'number' } })
      await narsil.insert('articles', { title: 'alpha one', topics: ['news', 'tech'], rank: 2 })
      await narsil.insert('articles', { title: 'alpha two', topics: ['news'], rank: 1 })
      await narsil.insert('articles', { title: 'beta three', topics: ['sport'], rank: 3 })

      const unsorted = await narsil.query('articles', { term: 'alpha', facets: { topics: {} } })
      const sorted = await narsil.query('articles', {
        term: 'alpha',
        sort: { rank: 'asc' },
        facets: { topics: {} },
      })

      expect(unsorted.facets?.topics.values).toEqual({ news: 2, tech: 1 })
      expect(sorted.facets?.topics.values).toEqual(unsorted.facets?.topics.values)
    })
  })

  describe('preflight', () => {
    it('returns count and elapsed without building full hits', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Fast Charger', category: 'electronics', price: 30 })
      await narsil.insert('products', { title: 'Slow Charger', category: 'electronics', price: 10 })

      const result = await narsil.preflight('products', { term: 'charger' })
      expect(result.count).toBe(2)
      expect(result.elapsed).toBeGreaterThanOrEqual(0)
    })

    it('reports the same count a query reports under filters and fuzziness', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Fast Charger', category: 'electronics', price: 30 })
      await narsil.insert('products', { title: 'Slow Charger', category: 'electronics', price: 10 })
      await narsil.insert('products', { title: 'Charging Dock', category: 'accessories', price: 20 })

      const params = {
        term: 'chargr',
        tolerance: 1,
        filters: { fields: { price: { gte: 15 } } } as FilterExpression,
      }
      const queried = await narsil.query('products', params)
      const preflight = await narsil.preflight('products', params)
      expect(preflight.count).toBe(queried.count)
    })

    it('reports the same count a query reports when minScore prunes matches', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Fast Charger', category: 'electronics', price: 30 })
      await narsil.insert('products', { title: 'Slow Charger Charger', category: 'electronics', price: 10 })

      const unfiltered = await narsil.query('products', { term: 'charger', includeScores: true })
      const scores = unfiltered.hits.map(hit => hit.score ?? 0).sort((a, b) => b - a)
      const betweenScores = (scores[0] + scores[1]) / 2

      const params = { term: 'charger', minScore: betweenScores }
      const queried = await narsil.query('products', params)
      const preflight = await narsil.preflight('products', params)
      expect(queried.count).toBe(1)
      expect(preflight.count).toBe(queried.count)
    })

    it('reports the same count a query reports under a termMatch policy', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Fast Charger', category: 'electronics', price: 30 })
      await narsil.insert('products', { title: 'Fast Cable', category: 'accessories', price: 5 })

      const params = { term: 'fast charger', termMatch: 'all' as const }
      const queried = await narsil.query('products', params)
      const preflight = await narsil.preflight('products', params)
      expect(queried.count).toBe(1)
      expect(preflight.count).toBe(queried.count)
    })
  })

  describe('cursor binding', () => {
    async function indexWithChargers(): Promise<void> {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Fast Charger', category: 'electronics', price: 30 })
      await narsil.insert('products', { title: 'Slow Charger', category: 'electronics', price: 10 })
      await narsil.insert('products', { title: 'Wall Charger', category: 'electronics', price: 20 })
    }

    it('pages on with the cursor under the same query', async () => {
      await indexWithChargers()
      const firstPage = await narsil.query('products', { term: 'charger', limit: 2 })
      expect(firstPage.cursor).toBeDefined()

      const secondPage = await narsil.query('products', { term: 'charger', limit: 2, searchAfter: firstPage.cursor })
      expect(secondPage.hits).toHaveLength(1)
    })

    it('rejects the cursor under a changed term', async () => {
      await indexWithChargers()
      const firstPage = await narsil.query('products', { term: 'charger', limit: 2 })

      await expect(
        narsil.query('products', { term: 'wall', limit: 2, searchAfter: firstPage.cursor }),
      ).rejects.toMatchObject({ code: 'SEARCH_INVALID_CURSOR' })
    })

    it('rejects the cursor under changed filters', async () => {
      await indexWithChargers()
      const firstPage = await narsil.query('products', { term: 'charger', limit: 2 })

      await expect(
        narsil.query('products', {
          term: 'charger',
          limit: 2,
          filters: { fields: { price: { gte: 15 } } },
          searchAfter: firstPage.cursor,
        }),
      ).rejects.toMatchObject({ code: 'SEARCH_INVALID_CURSOR' })
    })

    it('rejects a listing cursor under changed filters', async () => {
      await indexWithChargers()
      const firstPage = await narsil.listDocuments('products', { limit: 2 })
      expect(firstPage.cursor).not.toBeNull()

      const cursor = firstPage.cursor ?? undefined
      await expect(
        narsil.listDocuments('products', { limit: 2, filters: { fields: { price: { gte: 15 } } }, cursor }),
      ).rejects.toMatchObject({ code: 'SEARCH_INVALID_CURSOR' })
    })

    it('pages a sorted query on and rejects its cursor under a changed term', async () => {
      await indexWithChargers()
      const firstPage = await narsil.query('products', { term: 'charger', sort: { price: 'asc' }, limit: 2 })
      expect(firstPage.cursor).toBeDefined()

      const secondPage = await narsil.query('products', {
        term: 'charger',
        sort: { price: 'asc' },
        limit: 2,
        searchAfter: firstPage.cursor,
      })
      expect(secondPage.hits).toHaveLength(1)

      await expect(
        narsil.query('products', {
          term: 'wall',
          sort: { price: 'asc' },
          limit: 2,
          searchAfter: firstPage.cursor,
        }),
      ).rejects.toMatchObject({ code: 'SEARCH_INVALID_CURSOR' })
    })
  })

  describe('index-time analyzer overrides', () => {
    it('applies a stopWords override at index time so a default stop word stays searchable', async () => {
      await narsil.createIndex('articles', {
        schema: { title: 'string' as const },
        language: 'english',
        stopWords: new Set<string>(),
      })
      await narsil.insert('articles', { title: 'research during pregnancy' }, 'a1')

      const result = await narsil.query('articles', { term: 'during' })
      expect(result.hits.map(h => h.id)).toEqual(['a1'])
    })
  })

  describe('score components', () => {
    it('returns components only when requested without changing ranking or scores', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'wireless mouse', category: 'electronics', price: 25 }, 'p1')
      await narsil.insert('products', { title: 'wireless wireless keyboard', category: 'electronics', price: 45 }, 'p2')

      const lean = await narsil.query('products', { term: 'wireless' })
      const explained = await narsil.query('products', { term: 'wireless', includeScoreComponents: true })

      expect(lean.hits.map(h => h.id)).toEqual(explained.hits.map(h => h.id))
      expect(lean.hits.map(h => h.score)).toEqual(explained.hits.map(h => h.score))
      expect(lean.hits[0].scoreComponents).toBeUndefined()
      expect(Object.keys(explained.hits[0].scoreComponents?.idf ?? {}).length).toBeGreaterThan(0)
    })
  })
})
