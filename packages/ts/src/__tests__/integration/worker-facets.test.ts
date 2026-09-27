import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import { createMemoryPersistence } from '../../persistence/memory'

const distEntry = new URL('../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

const CATEGORIES = ['electronics', 'books', 'clothing']
const CORPUS_SIZE = 60

describe.skipIf(!built)('a query spread across several workers', () => {
  it('brings back the facet counts of every partition', async () => {
    const narsil = await createNarsil({
      persistence: createMemoryPersistence(),
      workers: { enabled: true, count: 4, promotionThreshold: 10 },
    })

    try {
      await narsil.createIndex('catalogue', {
        schema: { title: 'string', category: 'enum' },
        language: 'english',
        partitions: { maxDocsPerPartition: 20, maxPartitions: 8, watermark: 0.9 },
      })

      const promoted = new Promise<number>(resolve => {
        narsil.on('workerPromote', payload => resolve(payload.workerCount))
      })
      const failed = new Promise<Error>(resolve => {
        narsil.on('workerPromoteFailure', payload => resolve(payload.error))
      })

      for (let i = 0; i < CORPUS_SIZE; i++) {
        await narsil.insert(
          'catalogue',
          { title: `alpha item ${i}`, category: CATEGORIES[i % CATEGORIES.length] },
          `doc-${String(i).padStart(3, '0')}`,
        )
      }

      expect(await Promise.race([promoted, failed])).toBe(2)

      const result = await narsil.query('catalogue', { term: 'alpha', limit: 5, facets: { category: {} } })

      expect(result.count).toBe(CORPUS_SIZE)
      expect(result.facets?.category.values).toEqual({
        electronics: CORPUS_SIZE / CATEGORIES.length,
        books: CORPUS_SIZE / CATEGORIES.length,
        clothing: CORPUS_SIZE / CATEGORIES.length,
      })
    } finally {
      await narsil.shutdown()
    }
  })

  it('finds the rarest values and counts every price range as one thread does', async () => {
    const stockists = Array.from({ length: 240 }, (_, serial) => ({
      id: `stock-${String(serial).padStart(3, '0')}`,
      title: `alpha stockist ${serial}`,
      maker: `maker-${String((serial * serial) % 53).padStart(2, '0')}`,
      price: (serial * 37) % 400,
    }))
    const schema = { title: 'string', maker: 'string', price: 'number' } as const
    const facets = {
      maker: { sort: 'asc' as const, limit: 3 },
      price: {
        ranges: [
          { from: 0, to: 100 },
          { from: 100, to: 250 },
          { from: 250, to: 400 },
        ],
      },
    }

    const single = await createNarsil({ persistence: createMemoryPersistence(), workers: { enabled: false } })
    const split = await createNarsil({
      persistence: createMemoryPersistence(),
      workers: { enabled: true, count: 4, promotionThreshold: 10 },
    })

    try {
      await single.createIndex('stockists', { schema, language: 'english' })
      await single.insertBatch('stockists', stockists)
      const truth = await single.query('stockists', { term: 'alpha', limit: 5, facets })

      await split.createIndex('stockists', {
        schema,
        language: 'english',
        partitions: { maxDocsPerPartition: 40, maxPartitions: 8, watermark: 0.9 },
      })
      const promoted = new Promise<number>(resolve => {
        split.on('workerPromote', payload => resolve(payload.workerCount))
      })
      await split.insertBatch('stockists', stockists)
      expect(await promoted).toBeGreaterThanOrEqual(2)

      const answers = await Promise.all(
        Array.from({ length: 3 }, () => split.query('stockists', { term: 'alpha', limit: 5, facets })),
      )
      for (const answer of answers) expect(answer.facets).toEqual(truth.facets)
    } finally {
      await split.shutdown()
      await single.shutdown()
    }
  })
})
