import { describe, expect, it } from 'vitest'
import { createPartitionIndex } from '../../core/partition'
import { getLanguage } from '../../languages/registry'
import { createPartitionManager } from '../../partitioning/manager'
import { createPartitionRouter } from '../../partitioning/router'
import type { AnyDocument, IndexConfig, SchemaDefinition } from '../../types/schema'

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

type ProductDoc = AnyDocument & {
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

describe('Persistence Round-Trip Integration', () => {
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
})
