import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { generateProducts, indexConfig, type ProductDoc } from './fixtures'

describe('Search Pipeline Integration - combined search features', () => {
  let narsil: Narsil
  const allProducts = generateProducts()

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('products', indexConfig)

    for (const product of allProducts) {
      await narsil.insert('products', product)
    }

    const count = await narsil.countDocuments('products')
    expect(count).toBe(200)
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('combines filters, sorting, and pagination', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      term: 'wireless',
      filters: {
        fields: {
          category: { eq: 'electronics' },
          price: { gte: 20, lte: 200 },
          inStock: { eq: true },
        },
      },
      sort: { price: 'asc' },
      limit: 5,
      offset: 0,
    })

    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.length).toBeLessThanOrEqual(5)

    for (const hit of result.hits) {
      expect(hit.document.category).toBe('electronics')
      expect(hit.document.price).toBeGreaterThanOrEqual(20)
      expect(hit.document.price).toBeLessThanOrEqual(200)
      expect(hit.document.inStock).toBe(true)
    }

    const prices = result.hits.map(h => h.document.price)
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1])
    }

    if (result.count > 5) {
      const page2 = await narsil.query<ProductDoc>('products', {
        term: 'wireless',
        filters: {
          fields: {
            category: { eq: 'electronics' },
            price: { gte: 20, lte: 200 },
            inStock: { eq: true },
          },
        },
        sort: { price: 'asc' },
        limit: 5,
        offset: 5,
      })

      const page1Ids = new Set(result.hits.map(h => h.id))
      for (const hit of page2.hits) {
        expect(page1Ids.has(hit.id)).toBe(false)
      }
    }
  })

  it('combines facets with grouping', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      term: 'set',
      facets: {
        category: {},
      },
      group: { fields: ['category'] },
    })

    expect(result.facets).toBeDefined()
    expect(result.facets?.category).toBeDefined()
    const categoryFacet = result.facets?.category
    if (!categoryFacet) throw new Error('expected category facet to be defined')
    expect(Object.keys(categoryFacet.values).length).toBeGreaterThan(0)

    expect(result.groups).toBeDefined()
    expect(result.groups?.length).toBeGreaterThan(0)

    const groupedCategories = new Set(result.groups?.map(g => g.values.category as string))
    const facetCategories = new Set(Object.keys(categoryFacet.values))

    for (const cat of groupedCategories) {
      expect(facetCategories.has(cat)).toBe(true)
    }
  })

  it('combines highlighting with filters', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      term: 'wireless keyboard',
      filters: {
        fields: {
          category: { eq: 'electronics' },
        },
      },
      highlight: {
        fields: ['title', 'description'],
      },
    })

    expect(result.hits.length).toBeGreaterThan(0)

    for (const hit of result.hits) {
      expect(hit.document.category).toBe('electronics')
    }

    const hitsWithHighlights = result.hits.filter(h => h.highlights?.title || h.highlights?.description)
    expect(hitsWithHighlights.length).toBeGreaterThan(0)
  })

  it('returns an empty result set for a term with no matches', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      term: 'xyznonexistentterm',
    })

    expect(result.hits.length).toBe(0)
    expect(result.count).toBe(0)
  })

  it('returns all documents when no term is provided but filters are present', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      filters: {
        fields: {
          category: { eq: 'electronics' },
          inStock: { eq: true },
        },
      },
      limit: 100,
    })

    for (const hit of result.hits) {
      expect(hit.document.category).toBe('electronics')
      expect(hit.document.inStock).toBe(true)
    }
  })
})
