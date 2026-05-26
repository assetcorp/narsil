import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { indexConfig, products } from './fixtures'

describe('Index Lifecycle Integration', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('creates an index, populates it, queries, updates, removes, drops, and shuts down', async () => {
    await narsil.createIndex('products', indexConfig)

    const indexes = narsil.listIndexes()
    expect(indexes.length).toBe(1)
    expect(indexes[0].name).toBe('products')

    const insertedIds: string[] = []
    for (const product of products) {
      const id = await narsil.insert('products', product)
      insertedIds.push(id)
    }

    const count = await narsil.countDocuments('products')
    expect(count).toBe(50)

    const wirelessResults = await narsil.query('products', { term: 'wireless' })
    expect(wirelessResults.hits.length).toBeGreaterThan(0)
    expect(wirelessResults.count).toBeGreaterThan(0)

    const wirelessDocTitles = wirelessResults.hits.map(h => (h.document as Record<string, unknown>).title as string)
    const hasWirelessMatch = wirelessDocTitles.some(t => t.toLowerCase().includes('wireless'))
    expect(hasWirelessMatch).toBe(true)

    const idsToUpdate = insertedIds.slice(0, 5)
    const newPrices = [999, 888, 777, 666, 555]

    for (let i = 0; i < idsToUpdate.length; i++) {
      const currentDoc = await narsil.get('products', idsToUpdate[i])
      expect(currentDoc).toBeDefined()
      await narsil.update('products', idsToUpdate[i], {
        ...currentDoc,
        price: newPrices[i],
      })
    }

    for (let i = 0; i < idsToUpdate.length; i++) {
      const updatedDoc = await narsil.get('products', idsToUpdate[i])
      expect(updatedDoc).toBeDefined()
      expect(updatedDoc?.price).toBe(newPrices[i])
    }

    const idsToRemove = insertedIds.slice(5, 10)
    for (const id of idsToRemove) {
      await narsil.remove('products', id)
    }

    const countAfterRemoval = await narsil.countDocuments('products')
    expect(countAfterRemoval).toBe(45)

    for (const id of idsToRemove) {
      const removed = await narsil.get('products', id)
      expect(removed).toBeUndefined()
    }

    const hasResult = await narsil.has('products', idsToRemove[0])
    expect(hasResult).toBe(false)

    const stillExists = await narsil.has('products', insertedIds[0])
    expect(stillExists).toBe(true)

    await narsil.dropIndex('products')

    const indexesAfterDrop = narsil.listIndexes()
    expect(indexesAfterDrop.length).toBe(0)

    await narsil.shutdown()
  })
})
