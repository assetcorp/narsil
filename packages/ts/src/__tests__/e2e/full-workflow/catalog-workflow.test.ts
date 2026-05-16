import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { createMemoryPersistence } from '../../../persistence/memory'
import type { AnyDocument } from '../../../types/schema'
import { generateDocuments, indexConfig } from './fixtures'

describe('E2E Full Workflow - catalog workflow', () => {
  let narsil: Narsil
  const documents = generateDocuments()
  const insertedIds: string[] = []

  afterEach(async () => {
    if (narsil) {
      await narsil.shutdown()
    }
  })

  it('runs a complete product catalog workflow end-to-end', async () => {
    narsil = await createNarsil({
      persistence: createMemoryPersistence(),
    })

    await narsil.createIndex('products', indexConfig)

    const indexes = narsil.listIndexes()
    expect(indexes.length).toBe(1)
    expect(indexes[0].name).toBe('products')

    const batchResult = await narsil.insertBatch('products', documents as unknown as AnyDocument[])
    expect(batchResult.succeeded.length).toBe(200)
    expect(batchResult.failed.length).toBe(0)
    insertedIds.push(...batchResult.succeeded)

    const count = await narsil.countDocuments('products')
    expect(count).toBe(200)

    const searchResult = await narsil.query('products', {
      term: 'wireless headphones',
    })
    expect(searchResult.hits.length).toBeGreaterThan(0)
    expect(searchResult.count).toBeGreaterThan(0)
    expect(searchResult.elapsed).toBeGreaterThanOrEqual(0)

    const hasWireless = searchResult.hits.some(hit => {
      const doc = hit.document as Record<string, unknown>
      const title = (doc.title as string).toLowerCase()
      const desc = (doc.description as string).toLowerCase()
      return (
        title.includes('wireless') ||
        desc.includes('wireless') ||
        title.includes('headphone') ||
        desc.includes('headphone')
      )
    })
    expect(hasWireless).toBe(true)

    const filteredResult = await narsil.query('products', {
      term: 'cable charging',
      filters: {
        fields: {
          price: { gte: 50, lte: 200 },
          inStock: { eq: true },
        },
      },
    })
    for (const hit of filteredResult.hits) {
      const doc = hit.document as Record<string, unknown>
      expect(doc.price as number).toBeGreaterThanOrEqual(50)
      expect(doc.price as number).toBeLessThanOrEqual(200)
      expect(doc.inStock).toBe(true)
    }

    const facetResult = await narsil.query('products', {
      term: 'premium',
      facets: { category: {} },
      limit: 200,
    })
    expect(facetResult.facets).toBeDefined()
    expect(facetResult.facets?.category).toBeDefined()
    const facetValues = facetResult.facets?.category.values ?? {}
    const facetCategories = Object.keys(facetValues)
    expect(facetCategories.length).toBeGreaterThan(0)

    const sortedResult = await narsil.query('products', {
      term: 'shoes',
      sort: { price: 'asc' },
    })
    if (sortedResult.hits.length > 1) {
      const prices = sortedResult.hits.map(h => (h.document as Record<string, unknown>).price as number)
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1])
      }
    }

    const page1 = await narsil.query('products', {
      term: 'cotton leather wool',
      limit: 5,
      offset: 0,
    })
    expect(page1.hits.length).toBeLessThanOrEqual(5)

    const page2 = await narsil.query('products', {
      term: 'cotton leather wool',
      limit: 5,
      offset: 5,
    })
    expect(page2.hits.length).toBeLessThanOrEqual(5)

    if (page1.hits.length > 0 && page2.hits.length > 0) {
      const page1Ids = new Set(page1.hits.map(h => h.id))
      for (const hit of page2.hits) {
        expect(page1Ids.has(hit.id)).toBe(false)
      }
    }

    const highlightResult = await narsil.query('products', {
      term: 'wireless',
      highlight: {
        fields: ['title'],
        preTag: '<b>',
        postTag: '</b>',
      },
    })
    expect(highlightResult.hits.length).toBeGreaterThan(0)
    const highlightedHit = highlightResult.hits.find(h => h.highlights?.title)
    expect(highlightedHit).toBeDefined()
    if (highlightedHit?.highlights?.title) {
      expect(highlightedHit.highlights.title.snippet).toContain('<b>')
      expect(highlightedHit.highlights.title.snippet).toContain('</b>')
    }

    const idsToUpdate = insertedIds.slice(0, 10)
    const newPrice = 999.99
    for (const docId of idsToUpdate) {
      const existing = await narsil.get('products', docId)
      if (existing) {
        await narsil.update('products', docId, {
          ...existing,
          price: newPrice,
        })
      }
    }

    for (const docId of idsToUpdate) {
      const updated = await narsil.get('products', docId)
      expect(updated).toBeDefined()
      expect(updated?.price).toBe(newPrice)
    }

    const idsToRemove = insertedIds.slice(10, 20)
    const removeResult = await narsil.removeBatch('products', idsToRemove)
    expect(removeResult.succeeded.length).toBe(10)
    expect(removeResult.failed.length).toBe(0)

    for (const docId of idsToRemove) {
      const gone = await narsil.get('products', docId)
      expect(gone).toBeUndefined()
      const exists = await narsil.has('products', docId)
      expect(exists).toBe(false)
    }

    const finalCount = await narsil.countDocuments('products')
    expect(finalCount).toBe(190)

    await narsil.shutdown()
  }, 30_000)
})
