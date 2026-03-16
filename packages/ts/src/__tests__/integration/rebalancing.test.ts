import { describe, expect, it } from 'vitest'
import { getLanguage } from '../../languages/registry'
import { fanOutQuery } from '../../partitioning/fan-out'
import { createPartitionManager } from '../../partitioning/manager'
import { createRebalancer } from '../../partitioning/rebalancer'
import { createPartitionRouter } from '../../partitioning/router'
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

function generateDocs(count: number): Array<{ docId: string; doc: ProductDoc }> {
  const categories = ['electronics', 'books', 'clothing', 'sports', 'home']
  const adjectives = ['premium', 'wireless', 'portable', 'durable', 'lightweight']
  const nouns = ['headphones', 'keyboard', 'shoes', 'guide', 'lamp']

  const items: Array<{ docId: string; doc: ProductDoc }> = []
  for (let i = 0; i < count; i++) {
    const catIndex = i % categories.length
    const adjIndex = i % adjectives.length
    const nounIndex = (i + 2) % nouns.length
    items.push({
      docId: `rebal-doc-${i}`,
      doc: {
        title: `${adjectives[adjIndex]} ${nouns[nounIndex]} model ${i}`,
        description: `High-quality ${categories[catIndex]} product number ${i} with advanced features`,
        price: 10 + (i % 200),
        inStock: i % 4 !== 0,
        category: categories[catIndex],
      },
    })
  }
  return items
}

describe('Rebalancing Integration', () => {
  const language = getLanguage('english')
  const router = createPartitionRouter()

  it('rebalances from 2 partitions to 4 and preserves all documents', async () => {
    const manager = createPartitionManager('products', indexConfig, language, router, 2)

    const docs = generateDocs(500)
    for (const { docId, doc } of docs) {
      manager.insert(docId, doc)
    }

    expect(manager.countDocuments()).toBe(500)
    expect(manager.partitionCount).toBe(2)

    const searchTermBefore = 'wireless'
    const resultBefore = await fanOutQuery(manager, { term: searchTermBefore }, language, schema, {
      scoringMode: 'local',
    })
    const matchedIdsBefore = new Set(resultBefore.scored.map(s => s.docId))
    expect(matchedIdsBefore.size).toBeGreaterThan(0)

    const rebalancer = createRebalancer()
    expect(rebalancer.isRebalancing()).toBe(false)

    const progressPhases: string[] = []
    await rebalancer.rebalance(manager, 4, router, progress => {
      progressPhases.push(progress.phase)
    })

    expect(rebalancer.isRebalancing()).toBe(false)
    expect(manager.partitionCount).toBe(4)
    expect(manager.countDocuments()).toBe(500)

    expect(progressPhases).toContain('scanning')
    expect(progressPhases).toContain('moving')
    expect(progressPhases).toContain('swapping')
    expect(progressPhases).toContain('complete')

    for (const { docId, doc } of docs) {
      const retrieved = manager.get(docId)
      expect(retrieved).toBeDefined()
      expect(retrieved?.title).toBe(doc.title)
      expect(retrieved?.price).toBe(doc.price)
      expect(retrieved?.category).toBe(doc.category)
    }

    const resultAfter = await fanOutQuery(manager, { term: searchTermBefore }, language, schema, {
      scoringMode: 'local',
    })
    const matchedIdsAfter = new Set(resultAfter.scored.map(s => s.docId))

    expect(matchedIdsAfter.size).toBe(matchedIdsBefore.size)
    for (const id of matchedIdsBefore) {
      expect(matchedIdsAfter.has(id)).toBe(true)
    }
  })

  it('rebalances from 4 partitions back to 2 and preserves all documents', async () => {
    const manager = createPartitionManager('products', indexConfig, language, router, 4)

    const docs = generateDocs(500)
    for (const { docId, doc } of docs) {
      manager.insert(docId, doc)
    }

    expect(manager.countDocuments()).toBe(500)
    expect(manager.partitionCount).toBe(4)

    const searchTermBefore = 'portable'
    const resultBefore = await fanOutQuery(manager, { term: searchTermBefore }, language, schema, {
      scoringMode: 'local',
    })
    const matchedIdsBefore = new Set(resultBefore.scored.map(s => s.docId))

    const rebalancer = createRebalancer()
    await rebalancer.rebalance(manager, 2, router)

    expect(manager.partitionCount).toBe(2)
    expect(manager.countDocuments()).toBe(500)

    for (const { docId, doc } of docs) {
      const retrieved = manager.get(docId)
      expect(retrieved).toBeDefined()
      expect(retrieved?.title).toBe(doc.title)
      expect(retrieved?.category).toBe(doc.category)
    }

    const resultAfter = await fanOutQuery(manager, { term: searchTermBefore }, language, schema, {
      scoringMode: 'local',
    })
    const matchedIdsAfter = new Set(resultAfter.scored.map(s => s.docId))

    expect(matchedIdsAfter.size).toBe(matchedIdsBefore.size)
    for (const id of matchedIdsBefore) {
      expect(matchedIdsAfter.has(id)).toBe(true)
    }
  })

  it('rebalances from 2 to 4 and back to 2 in sequence', async () => {
    const manager = createPartitionManager('products', indexConfig, language, router, 2)

    const docs = generateDocs(500)
    for (const { docId, doc } of docs) {
      manager.insert(docId, doc)
    }

    const resultOriginal = await fanOutQuery(manager, { term: 'headphones' }, language, schema, {
      scoringMode: 'local',
    })
    const originalIds = new Set(resultOriginal.scored.map(s => s.docId))

    const rebalancer = createRebalancer()

    await rebalancer.rebalance(manager, 4, router)
    expect(manager.partitionCount).toBe(4)
    expect(manager.countDocuments()).toBe(500)

    const resultExpanded = await fanOutQuery(manager, { term: 'headphones' }, language, schema, {
      scoringMode: 'local',
    })
    const expandedIds = new Set(resultExpanded.scored.map(s => s.docId))
    expect(expandedIds.size).toBe(originalIds.size)
    for (const id of originalIds) {
      expect(expandedIds.has(id)).toBe(true)
    }

    await rebalancer.rebalance(manager, 2, router)
    expect(manager.partitionCount).toBe(2)
    expect(manager.countDocuments()).toBe(500)

    const resultCompacted = await fanOutQuery(manager, { term: 'headphones' }, language, schema, {
      scoringMode: 'local',
    })
    const compactedIds = new Set(resultCompacted.scored.map(s => s.docId))
    expect(compactedIds.size).toBe(originalIds.size)
    for (const id of originalIds) {
      expect(compactedIds.has(id)).toBe(true)
    }

    for (const { docId, doc } of docs) {
      const retrieved = manager.get(docId)
      expect(retrieved).toBeDefined()
      expect(retrieved?.title).toBe(doc.title)
      expect(retrieved?.price).toBe(doc.price)
    }
  })

  it('rejects rebalancing to the same partition count', async () => {
    const manager = createPartitionManager('products', indexConfig, language, router, 2)

    const rebalancer = createRebalancer()
    await expect(rebalancer.rebalance(manager, 2, router)).rejects.toThrow('same as the current count')
  })

  it('rejects concurrent rebalancing attempts', async () => {
    const manager = createPartitionManager('products', indexConfig, language, router, 2)

    const docs = generateDocs(200)
    for (const { docId, doc } of docs) {
      manager.insert(docId, doc)
    }

    const rebalancer = createRebalancer()

    const firstRebalance = rebalancer.rebalance(manager, 4, router)

    await expect(rebalancer.rebalance(manager, 3, router)).rejects.toThrow('already in progress')

    await firstRebalance
    expect(manager.partitionCount).toBe(4)
    expect(manager.countDocuments()).toBe(200)
  })

  it('maintains search functionality with filters after rebalancing', async () => {
    const manager = createPartitionManager('products', indexConfig, language, router, 2)

    const docs = generateDocs(300)
    for (const { docId, doc } of docs) {
      manager.insert(docId, doc)
    }

    const resultBefore = await fanOutQuery(
      manager,
      {
        term: 'premium',
        filters: {
          fields: {
            category: { eq: 'electronics' },
          },
        },
      },
      language,
      schema,
      { scoringMode: 'local' },
    )
    const matchedBefore = new Set(resultBefore.scored.map(s => s.docId))

    const rebalancer = createRebalancer()
    await rebalancer.rebalance(manager, 5, router)

    expect(manager.partitionCount).toBe(5)
    expect(manager.countDocuments()).toBe(300)

    const resultAfter = await fanOutQuery(
      manager,
      {
        term: 'premium',
        filters: {
          fields: {
            category: { eq: 'electronics' },
          },
        },
      },
      language,
      schema,
      { scoringMode: 'local' },
    )
    const matchedAfter = new Set(resultAfter.scored.map(s => s.docId))

    expect(matchedAfter.size).toBe(matchedBefore.size)
    for (const id of matchedBefore) {
      expect(matchedAfter.has(id)).toBe(true)
    }
  })
})
