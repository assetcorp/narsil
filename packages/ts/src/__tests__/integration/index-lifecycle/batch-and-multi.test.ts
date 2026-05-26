import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { indexConfig, products, schema } from './fixtures'

describe('Index Lifecycle Integration', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('handles batch insert, update, and remove operations', async () => {
    await narsil.createIndex('products', indexConfig)

    const batchResult = await narsil.insertBatch('products', products.slice(0, 20))
    expect(batchResult.succeeded.length).toBe(20)
    expect(batchResult.failed.length).toBe(0)

    const count = await narsil.countDocuments('products')
    expect(count).toBe(20)

    const updateBatchResult = await narsil.updateBatch('products', [
      { docId: batchResult.succeeded[0], document: { ...products[0], price: 999 } },
      { docId: batchResult.succeeded[1], document: { ...products[1], price: 888 } },
    ])
    expect(updateBatchResult.succeeded.length).toBe(2)
    expect(updateBatchResult.failed.length).toBe(0)

    const updated = await narsil.get('products', batchResult.succeeded[0])
    expect(updated?.price).toBe(999)

    const removeBatchResult = await narsil.removeBatch('products', batchResult.succeeded.slice(0, 5))
    expect(removeBatchResult.succeeded.length).toBe(5)
    expect(removeBatchResult.failed.length).toBe(0)

    const countAfterRemoval = await narsil.countDocuments('products')
    expect(countAfterRemoval).toBe(15)
  })

  it('supports multiple indexes existing simultaneously', async () => {
    await narsil.createIndex('products', indexConfig)
    await narsil.createIndex('articles', {
      schema: { title: 'string', body: 'string', published: 'boolean' },
      language: 'english',
    })

    const indexes = narsil.listIndexes()
    expect(indexes.length).toBe(2)
    expect(indexes.map(i => i.name).sort()).toEqual(['articles', 'products'])

    await narsil.insert('products', products[0])
    await narsil.insert('articles', {
      title: 'Wireless Technology Advances',
      body: 'The latest in wireless communication and devices',
      published: true,
    })

    const productResults = await narsil.query('products', { term: 'wireless' })
    const articleResults = await narsil.query('articles', { term: 'wireless' })

    expect(productResults.hits.length).toBeGreaterThan(0)
    expect(articleResults.hits.length).toBeGreaterThan(0)

    await narsil.dropIndex('products')
    const remaining = narsil.listIndexes()
    expect(remaining.length).toBe(1)
    expect(remaining[0].name).toBe('articles')
  })

  it('reports correct stats for an index', async () => {
    await narsil.createIndex('products', indexConfig)

    for (const product of products.slice(0, 10)) {
      await narsil.insert('products', product)
    }

    const stats = narsil.getStats('products')
    expect(stats.documentCount).toBe(10)
    expect(stats.partitionCount).toBeGreaterThanOrEqual(1)
    expect(stats.language).toBe('english')
    expect(stats.schema).toEqual(schema)
  })
})
