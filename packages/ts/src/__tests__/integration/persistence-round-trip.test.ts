import { afterEach, describe, expect, it } from 'vitest'
import { createPartitionIndex } from '../../core/partition'
import { getLanguage } from '../../languages/registry'
import { createPartitionManager } from '../../partitioning/manager'
import { createPartitionRouter } from '../../partitioning/router'
import { createFlushManager } from '../../persistence/flush-manager'
import { createMemoryPersistence } from '../../persistence/memory'
import type { InvalidationAdapter, InvalidationEvent } from '../../types/adapters'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'

const schema: SchemaDefinition = {
  title: 'string',
  description: 'string',
  price: 'number',
  inStock: 'boolean',
  category: 'enum',
}

const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

interface ProductDoc {
  title: string
  description: string
  price: number
  inStock: boolean
  category: string
}

function generateDocs(count: number): ProductDoc[] {
  const categories = ['electronics', 'books', 'clothing', 'sports', 'home']
  const items: ProductDoc[] = []
  for (let i = 0; i < count; i++) {
    const catIndex = i % categories.length
    items.push({
      title: `Product ${i} ${categories[catIndex]} edition`,
      description: `A high-quality ${categories[catIndex]} product with serial number ${i}`,
      price: 10 + (i % 100),
      inStock: i % 3 !== 0,
      category: categories[catIndex],
    })
  }
  return items
}

function createNoopInvalidation(): InvalidationAdapter {
  return {
    async publish(_event: InvalidationEvent): Promise<void> {},
    async subscribe(_handler: (event: InvalidationEvent) => void): Promise<void> {},
    async shutdown(): Promise<void> {},
  }
}

describe('Persistence Round-Trip Integration', () => {
  let flushManagerRef: { shutdown: () => Promise<void> } | null = null

  afterEach(async () => {
    if (flushManagerRef) {
      await flushManagerRef.shutdown()
      flushManagerRef = null
    }
  })

  it('persists data through the flush manager and memory adapter', async () => {
    const persistence = createMemoryPersistence()
    const invalidation = createNoopInvalidation()
    const language = getLanguage('english')
    const router = createPartitionRouter()
    const manager = createPartitionManager('products', indexConfig, language, router, 2)

    const docs = generateDocs(100)
    const docIds: string[] = []

    for (let i = 0; i < docs.length; i++) {
      const docId = `doc-${i}`
      manager.insert(docId, docs[i])
      docIds.push(docId)
    }

    expect(manager.countDocuments()).toBe(100)

    const flushManager = createFlushManager(
      {
        persistence,
        invalidation,
        interval: 60_000,
        mutationThreshold: 10_000,
      },
      (_indexName: string, partitionId: number) => {
        const serialized = manager.serializePartition(partitionId)
        const encoder = new TextEncoder()
        return encoder.encode(JSON.stringify(serialized))
      },
      () => 'test-instance',
    )
    flushManagerRef = flushManager

    for (let p = 0; p < manager.partitionCount; p++) {
      flushManager.markDirty('products', p)
    }
    await flushManager.flush()

    const keys = await persistence.list('products/')
    expect(keys.length).toBe(manager.partitionCount)

    for (const key of keys) {
      const data = await persistence.load(key)
      expect(data).not.toBeNull()
      expect(data?.length).toBeGreaterThan(0)
    }

    await flushManager.shutdown()
    flushManagerRef = null
  })

  it('round-trips partition data through serialize and deserialize', () => {
    const language = getLanguage('english')
    const partition = createPartitionIndex(0)

    const docs = generateDocs(50)
    const docIds: string[] = []
    for (let i = 0; i < docs.length; i++) {
      const docId = `rt-doc-${i}`
      partition.insert(docId, docs[i], schema, language)
      docIds.push(docId)
    }

    expect(partition.count()).toBe(50)

    const serialized = partition.serialize('test-index', 1, 'english', schema)

    const restoredPartition = createPartitionIndex(0)
    restoredPartition.deserialize(serialized, schema)

    expect(restoredPartition.count()).toBe(50)

    for (const docId of docIds) {
      expect(restoredPartition.has(docId)).toBe(true)
      const original = partition.get(docId)
      const restored = restoredPartition.get(docId)
      expect(restored).toBeDefined()
      expect(restored?.title).toBe(original?.title)
      expect(restored?.price).toBe(original?.price)
      expect(restored?.category).toBe(original?.category)
    }
  })

  it('round-trips through the partition manager serialize and deserialize', () => {
    const language = getLanguage('english')
    const router = createPartitionRouter()
    const manager = createPartitionManager('products', indexConfig, language, router, 2)

    const docs = generateDocs(100)
    const docIds: string[] = []

    for (let i = 0; i < docs.length; i++) {
      const docId = `mgr-doc-${i}`
      manager.insert(docId, docs[i])
      docIds.push(docId)
    }

    expect(manager.countDocuments()).toBe(100)

    const serializedPartitions = []
    for (let p = 0; p < manager.partitionCount; p++) {
      serializedPartitions.push(manager.serializePartition(p))
    }

    const newManager = createPartitionManager('products', indexConfig, language, router, 2)

    for (let p = 0; p < newManager.partitionCount; p++) {
      newManager.deserializePartition(p, serializedPartitions[p])
    }

    expect(newManager.countDocuments()).toBe(100)

    for (const docId of docIds) {
      expect(newManager.has(docId)).toBe(true)
      const original = manager.get(docId)
      const restored = newManager.get(docId)
      expect(restored).toBeDefined()
      expect(restored?.title).toBe(original?.title)
      expect(restored?.price).toBe(original?.price)
    }
  })

  it('preserves data after flush manager shutdown', async () => {
    const persistence = createMemoryPersistence()
    const invalidation = createNoopInvalidation()
    const language = getLanguage('english')
    const router = createPartitionRouter()
    const manager = createPartitionManager('products', indexConfig, language, router, 1)

    const docs = generateDocs(30)
    for (let i = 0; i < docs.length; i++) {
      manager.insert(`sd-doc-${i}`, docs[i])
    }

    const flushManager = createFlushManager(
      {
        persistence,
        invalidation,
        interval: 60_000,
        mutationThreshold: 10_000,
      },
      (_indexName: string, partitionId: number) => {
        const serialized = manager.serializePartition(partitionId)
        const encoder = new TextEncoder()
        return encoder.encode(JSON.stringify(serialized))
      },
      () => 'shutdown-test-instance',
    )
    flushManagerRef = flushManager

    flushManager.markDirty('products', 0)
    await flushManager.shutdown()
    flushManagerRef = null

    const keys = await persistence.list('products/')
    expect(keys.length).toBe(1)

    const data = await persistence.load(keys[0])
    expect(data).not.toBeNull()

    const decoder = new TextDecoder()
    const parsed = JSON.parse(decoder.decode(data ?? new Uint8Array()))
    expect(parsed).toBeDefined()
    expect(parsed.documents).toBeDefined()
  })

  it('stores correct keys in memory persistence after multiple indexes flush', async () => {
    const persistence = createMemoryPersistence()
    const invalidation = createNoopInvalidation()
    const language = getLanguage('english')
    const router = createPartitionRouter()

    const manager1 = createPartitionManager('products', indexConfig, language, router, 2)
    const articlesConfig: IndexConfig = {
      schema: { title: 'string', body: 'string' },
      language: 'english',
    }
    const manager2 = createPartitionManager('articles', articlesConfig, language, router, 1)

    for (let i = 0; i < 10; i++) {
      manager1.insert(`prod-${i}`, {
        title: `Product ${i}`,
        description: `Description for product ${i}`,
        price: 10 + i,
        inStock: true,
        category: 'electronics',
      })
    }

    for (let i = 0; i < 5; i++) {
      manager2.insert(`art-${i}`, {
        title: `Article ${i}`,
        body: `Body content of article number ${i}`,
      })
    }

    const managers = new Map<string, { manager: typeof manager1; partitionCount: number }>()
    managers.set('products', { manager: manager1, partitionCount: 2 })
    managers.set('articles', { manager: manager2, partitionCount: 1 })

    const flushManager = createFlushManager(
      {
        persistence,
        invalidation,
        interval: 60_000,
        mutationThreshold: 10_000,
      },
      (indexName: string, partitionId: number) => {
        const entry = managers.get(indexName)
        if (!entry) throw new Error(`Unknown index: ${indexName}`)
        const serialized = entry.manager.serializePartition(partitionId)
        const encoder = new TextEncoder()
        return encoder.encode(JSON.stringify(serialized))
      },
      () => 'multi-index-instance',
    )
    flushManagerRef = flushManager

    for (let p = 0; p < 2; p++) {
      flushManager.markDirty('products', p)
    }
    flushManager.markDirty('articles', 0)

    await flushManager.flush()

    const productKeys = await persistence.list('products/')
    const articleKeys = await persistence.list('articles/')

    expect(productKeys.length).toBe(2)
    expect(articleKeys.length).toBe(1)

    for (const key of [...productKeys, ...articleKeys]) {
      const data = await persistence.load(key)
      expect(data).not.toBeNull()
      expect(data?.length).toBeGreaterThan(0)
    }

    await flushManager.shutdown()
    flushManagerRef = null
  })
})
