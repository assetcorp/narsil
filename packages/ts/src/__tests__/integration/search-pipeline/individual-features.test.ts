import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { generateProducts, indexConfig, type ProductDoc } from './fixtures'

describe('Search Pipeline Integration - individual search features', () => {
  let narsil: Narsil
  let docIds: string[]
  const allProducts = generateProducts()

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('products', indexConfig)

    docIds = []
    for (const product of allProducts) {
      const id = await narsil.insert('products', product)
      docIds.push(id)
    }

    const count = await narsil.countDocuments('products')
    expect(count).toBe(200)
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('returns results for a fulltext search term', async () => {
    const result = await narsil.query<ProductDoc>('products', { term: 'wireless' })

    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.count).toBeGreaterThan(0)
    expect(result.elapsed).toBeGreaterThanOrEqual(0)

    for (const hit of result.hits) {
      expect(hit.id).toBeTruthy()
      expect(hit.score).toBeGreaterThan(0)
      expect(hit.document).toBeDefined()
    }
  })

  it('applies numeric range filters on price', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      term: 'wireless',
      filters: {
        fields: {
          price: { gte: 50, lte: 150 },
        },
      },
    })

    expect(result.hits.length).toBeGreaterThan(0)
    for (const hit of result.hits) {
      expect(hit.document.price).toBeGreaterThanOrEqual(50)
      expect(hit.document.price).toBeLessThanOrEqual(150)
    }
  })

  it('applies enum filters on category', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      term: 'wireless',
      filters: {
        fields: {
          category: { eq: 'electronics' },
        },
      },
    })

    expect(result.hits.length).toBeGreaterThan(0)
    for (const hit of result.hits) {
      expect(hit.document.category).toBe('electronics')
    }
  })

  it('applies boolean filters on inStock', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      term: 'swimming goggles',
      filters: {
        fields: {
          inStock: { eq: true },
        },
      },
    })

    for (const hit of result.hits) {
      expect(hit.document.inStock).toBe(true)
    }
  })

  it('returns facets on the category field', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      term: 'wireless',
      facets: {
        category: {},
      },
    })

    expect(result.facets).toBeDefined()
    expect(result.facets?.category).toBeDefined()
    expect(result.facets?.category.values).toBeDefined()

    const facetValues = result.facets?.category.values
    if (!facetValues) throw new Error('expected facetValues to be defined')
    expect(Object.keys(facetValues).length).toBeGreaterThan(0)
  })

  it('sorts results by price ascending', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      term: 'shoes',
      sort: { price: 'asc' },
    })

    expect(result.hits.length).toBeGreaterThan(0)
    const prices = result.hits.map(h => h.document.price)
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1])
    }
  })

  it('sorts results by price descending', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      term: 'shoes',
      sort: { price: 'desc' },
    })

    expect(result.hits.length).toBeGreaterThan(0)
    const prices = result.hits.map(h => h.document.price)
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeLessThanOrEqual(prices[i - 1])
    }
  })

  it('sorts results by a string field', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      term: 'shirt',
      sort: { title: 'asc' },
    })

    expect(result.hits.length).toBeGreaterThan(0)
    const titles = result.hits.map(h => h.document.title)
    for (let i = 1; i < titles.length; i++) {
      expect(titles[i].localeCompare(titles[i - 1])).toBeGreaterThanOrEqual(0)
    }
  })

  it('groups results by category', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      term: 'set',
      group: { fields: ['category'], maxPerGroup: 3 },
    })

    expect(result.groups).toBeDefined()
    const groups = result.groups ?? []
    expect(groups.length).toBeGreaterThan(0)

    for (const group of groups) {
      expect(group.values.category).toBeDefined()
      expect(group.hits.length).toBeGreaterThan(0)
      expect(group.hits.length).toBeLessThanOrEqual(3)
    }
  })

  it('paginates with offset-based pagination', async () => {
    const page1 = await narsil.query<ProductDoc>('products', {
      term: 'wireless',
      limit: 5,
      offset: 0,
    })

    const page2 = await narsil.query<ProductDoc>('products', {
      term: 'wireless',
      limit: 5,
      offset: 5,
    })

    expect(page1.hits.length).toBe(5)
    expect(page2.hits.length).toBeGreaterThan(0)

    const page1Ids = new Set(page1.hits.map(h => h.id))
    for (const hit of page2.hits) {
      expect(page1Ids.has(hit.id)).toBe(false)
    }
  })

  it('highlights matched terms in the title field', async () => {
    const result = await narsil.query<ProductDoc>('products', {
      term: 'wireless',
      highlight: {
        fields: ['title'],
        preTag: '<b>',
        postTag: '</b>',
      },
    })

    expect(result.hits.length).toBeGreaterThan(0)

    const hitsWithHighlights = result.hits.filter(h => h.highlights?.title)
    expect(hitsWithHighlights.length).toBeGreaterThan(0)

    for (const hit of hitsWithHighlights) {
      expect(hit.highlights?.title.snippet).toContain('<b>')
      expect(hit.highlights?.title.snippet).toContain('</b>')
    }
  })

  it('pins a specific document to position 0', async () => {
    const lastDocId = docIds[docIds.length - 1]

    const result = await narsil.query<ProductDoc>('products', {
      term: 'wireless',
      pinned: [{ docId: lastDocId, position: 0 }],
    })

    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0].id).toBe(lastDocId)
  })

  it('returns count without full results via preflight', async () => {
    const preflight = await narsil.preflight('products', { term: 'wireless' })

    expect(preflight.count).toBeGreaterThan(0)
    expect(preflight.elapsed).toBeGreaterThanOrEqual(0)

    const fullResult = await narsil.query<ProductDoc>('products', { term: 'wireless' })
    expect(preflight.count).toBe(fullResult.count)
  })
})
