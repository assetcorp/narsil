import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'

const productSchema: SchemaDefinition = {
  title: 'string' as const,
  category: 'enum' as const,
  price: 'number' as const,
  inStock: 'boolean' as const,
}

const vectorSchema: SchemaDefinition = {
  title: 'string' as const,
  embedding: 'vector[32]' as const,
}

function randomVector(dim: number): number[] {
  return Array.from({ length: dim }, () => Math.random() * 2 - 1)
}

describe('capacity + rebalancing + strict mode integration', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('fills index to capacity, rebalances, then inserts more after config update', async () => {
    const config: IndexConfig = {
      schema: productSchema,
      language: 'english',
      partitions: { maxDocsPerPartition: 50, maxPartitions: 2 },
    }
    await narsil.createIndex('products', config)

    for (let i = 0; i < 100; i++) {
      await narsil.insert('products', {
        title: `Wireless Gadget Model ${i}`,
        category: i % 2 === 0 ? 'electronics' : 'accessories',
        price: 10 + i,
        inStock: i % 3 !== 0,
      })
    }

    expect(await narsil.countDocuments('products')).toBe(100)

    try {
      await narsil.insert('products', { title: 'Overflow', category: 'electronics', price: 999, inStock: true })
      expect.fail('Expected capacity exceeded error')
    } catch (err) {
      expect((err as NarsilError).code).toBe(ErrorCodes.PARTITION_CAPACITY_EXCEEDED)
    }

    await narsil.rebalance('products', 4)

    expect(narsil.getStats('products').partitionCount).toBe(4)
    expect(await narsil.countDocuments('products')).toBe(100)

    const result = await narsil.query('products', { term: 'wireless' })
    expect(result.count).toBe(100)

    await narsil.updatePartitionConfig('products', { maxDocsPerPartition: 50, maxPartitions: 4 })
    await narsil.insert('products', {
      title: 'Post-Rebalance Wireless Item',
      category: 'electronics',
      price: 500,
      inStock: true,
    })
    expect(await narsil.countDocuments('products')).toBe(101)
  })

  it('strict mode catches extra fields in batch inserts', async () => {
    const config: IndexConfig = { schema: productSchema, language: 'english', strict: true }
    await narsil.createIndex('strict-products', config)

    const result = await narsil.insertBatch('strict-products', [
      { title: 'Valid Product', category: 'electronics', price: 99, inStock: true },
      { title: 'Invalid Product', category: 'electronics', price: 99, inStock: true, brand: 'Acme' },
      { title: 'Another Valid', category: 'accessories', price: 49, inStock: false },
    ])

    expect(result.succeeded.length).toBe(2)
    expect(result.failed.length).toBe(1)
    expect(result.failed[0].error.code).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
  })

  it('preserves vector search results after rebalancing', async () => {
    await narsil.createIndex('vectors', { schema: vectorSchema, language: 'english' })

    for (let i = 0; i < 50; i++) {
      await narsil.insert('vectors', { title: `Vector Document ${i}`, embedding: randomVector(32) })
    }

    const queryVec = randomVector(32)

    const before = await narsil.query('vectors', {
      mode: 'vector',
      vector: { field: 'embedding', value: queryVec, similarity: 0 },
      limit: 5,
    })
    expect(before.hits.length).toBeGreaterThan(0)

    await narsil.rebalance('vectors', 3)

    expect(await narsil.countDocuments('vectors')).toBe(50)
    expect(narsil.getStats('vectors').partitionCount).toBe(3)

    const after = await narsil.query('vectors', {
      mode: 'vector',
      vector: { field: 'embedding', value: queryVec, similarity: 0 },
      limit: 5,
    })
    expect(after.hits.length).toBeGreaterThan(0)
  })

  it('full CRUD lifecycle with capacity + strict + partitions', async () => {
    const config: IndexConfig = {
      schema: productSchema,
      language: 'english',
      strict: true,
      partitions: { maxDocsPerPartition: 100, maxPartitions: 2 },
    }
    await narsil.createIndex('products', config)

    const id1 = await narsil.insert(
      'products',
      { title: 'Wireless Keyboard', category: 'electronics', price: 75, inStock: true },
      'kb-1',
    )
    await narsil.insert(
      'products',
      { title: 'Wireless Mouse', category: 'electronics', price: 45, inStock: true },
      'mouse-1',
    )
    expect(id1).toBe('kb-1')

    const queryResult = await narsil.query('products', { term: 'wireless' })
    expect(queryResult.count).toBe(2)

    await narsil.update('products', 'kb-1', {
      title: 'Premium Wireless Keyboard',
      category: 'electronics',
      price: 150,
      inStock: false,
    })

    const updated = await narsil.get('products', 'kb-1')
    expect(updated?.title).toBe('Premium Wireless Keyboard')

    await expect(
      narsil.update('products', 'kb-1', {
        title: 'Invalid Update',
        category: 'electronics',
        price: 200,
        inStock: true,
        extraField: 'bad',
      }),
    ).rejects.toThrow(NarsilError)

    await narsil.remove('products', 'mouse-1')
    expect(await narsil.has('products', 'mouse-1')).toBe(false)
    expect(await narsil.countDocuments('products')).toBe(1)

    const stats = narsil.getStats('products')
    expect(stats.memoryBytes).toBeGreaterThan(0)
    expect(stats.documentCount).toBe(1)
  })

  it('empty index can be rebalanced', async () => {
    await narsil.createIndex('empty', { schema: productSchema, language: 'english' })
    await narsil.rebalance('empty', 3)
    expect(narsil.getStats('empty').partitionCount).toBe(3)
    expect(await narsil.countDocuments('empty')).toBe(0)
  })
})
