import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { indexConfig } from './fixtures'

describe('Narsil query features', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  describe('limit and offset clamping', () => {
    it('clamps limit to [0, 10000] and offset to [0, 100000]', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Test Item', category: 'test', price: 10 })

      const result = await narsil.query('products', {
        term: 'test',
        limit: 999999,
        offset: -5,
      })
      expect(result.hits.length).toBeLessThanOrEqual(10000)

      const result2 = await narsil.query('products', {
        term: 'test',
        limit: -1,
      })
      expect(result2.hits).toEqual([])
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
