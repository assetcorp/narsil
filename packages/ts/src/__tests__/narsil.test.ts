import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes, NarsilError } from '../errors'
import { createNarsil, type Narsil } from '../narsil'
import type { NarsilPlugin } from '../types/plugins'
import type { IndexConfig, SchemaDefinition } from '../types/schema'

const schema: SchemaDefinition = {
  title: 'string' as const,
  category: 'enum' as const,
  price: 'number' as const,
}

const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

describe('Narsil', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  describe('full lifecycle', () => {
    it('creates an index, inserts docs, queries, updates, removes, and shuts down', async () => {
      await narsil.createIndex('products', indexConfig)

      const id1 = await narsil.insert('products', {
        title: 'Wireless Headphones',
        category: 'electronics',
        price: 99,
      })
      const id2 = await narsil.insert('products', {
        title: 'Bluetooth Speaker',
        category: 'electronics',
        price: 49,
      })

      expect(id1).toBeTruthy()
      expect(id2).toBeTruthy()

      const result = await narsil.query('products', { term: 'wireless' })
      expect(result.hits.length).toBeGreaterThan(0)
      expect(result.count).toBeGreaterThan(0)
      expect(result.elapsed).toBeGreaterThanOrEqual(0)

      await narsil.update('products', id1, {
        title: 'Premium Wireless Headphones',
        category: 'electronics',
        price: 149,
      })

      const updated = await narsil.get('products', id1)
      expect(updated?.title).toBe('Premium Wireless Headphones')
      expect(updated?.price).toBe(149)

      await narsil.remove('products', id2)
      const removed = await narsil.get('products', id2)
      expect(removed).toBeUndefined()

      await narsil.shutdown()
    })
  })

  describe('plugin hooks', () => {
    it('fires beforeInsert and afterInsert hooks', async () => {
      const beforeCalls: string[] = []
      const afterCalls: string[] = []

      const plugin: NarsilPlugin = {
        name: 'test-plugin',
        beforeInsert(ctx) {
          beforeCalls.push(ctx.docId)
        },
        afterInsert(ctx) {
          afterCalls.push(ctx.docId)
        },
      }

      narsil = await createNarsil({ plugins: [plugin] })
      await narsil.createIndex('products', indexConfig)

      const docId = await narsil.insert(
        'products',
        { title: 'Laptop Stand', category: 'accessories', price: 35 },
        'custom-id',
      )

      expect(docId).toBe('custom-id')
      expect(beforeCalls).toContain('custom-id')
      expect(afterCalls).toContain('custom-id')
    })

    it('fires beforeSearch and afterSearch hooks', async () => {
      const searchTerms: string[] = []
      const resultCounts: number[] = []

      const plugin: NarsilPlugin = {
        name: 'search-tracker',
        beforeSearch(ctx) {
          searchTerms.push(ctx.params.term ?? '')
        },
        afterSearch(ctx) {
          resultCounts.push(ctx.results?.count ?? 0)
        },
      }

      narsil = await createNarsil({ plugins: [plugin] })
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Mechanical Keyboard', category: 'electronics', price: 120 })

      await narsil.query('products', { term: 'keyboard' })

      expect(searchTerms).toContain('keyboard')
      expect(resultCounts.length).toBe(1)
    })

    it('aborts insert when beforeInsert throws', async () => {
      const plugin: NarsilPlugin = {
        name: 'blocking-plugin',
        beforeInsert() {
          throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Blocked by plugin')
        },
      }

      narsil = await createNarsil({ plugins: [plugin] })
      await narsil.createIndex('products', indexConfig)

      await expect(narsil.insert('products', { title: 'Blocked Item', category: 'blocked', price: 0 })).rejects.toThrow(
        'Blocked by plugin',
      )

      const count = await narsil.countDocuments('products')
      expect(count).toBe(0)
    })

    it('does not abort insert when afterInsert throws', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const plugin: NarsilPlugin = {
        name: 'failing-after-plugin',
        afterInsert() {
          throw new Error('After hook failure')
        },
      }

      narsil = await createNarsil({ plugins: [plugin] })
      await narsil.createIndex('products', indexConfig)

      const docId = await narsil.insert('products', {
        title: 'Survives After Hook',
        category: 'electronics',
        price: 50,
      })

      expect(docId).toBeTruthy()
      const count = await narsil.countDocuments('products')
      expect(count).toBe(1)

      warnSpy.mockRestore()
    })
  })

  describe('event system', () => {
    it('registers and unregisters event handlers', () => {
      const calls: string[] = []
      const handler = (_payload: { workerId: number; indexNames: string[]; error: Error }) => {
        calls.push('called')
      }

      narsil.on('workerCrash', handler)
      narsil.off('workerCrash', handler)

      expect(calls.length).toBe(0)
    })
  })

  describe('batch operations', () => {
    it('returns partial failures in batch insert', async () => {
      const schema2: SchemaDefinition = {
        title: 'string' as const,
        price: 'number' as const,
      }

      narsil = await createNarsil()
      await narsil.createIndex('strict', { schema: schema2, language: 'english' })

      const documents = [
        { title: 'Valid Item One', price: 10 },
        { title: 'Valid Item Two', price: 20 },
        { title: 'Invalid Item', price: 'not-a-number' as unknown as number },
      ]

      const result = await narsil.insertBatch('strict', documents)
      expect(result.succeeded.length).toBe(2)
      expect(result.failed.length).toBe(1)
    })
  })

  describe('index name validation', () => {
    it('rejects empty index names', async () => {
      await expect(narsil.createIndex('', indexConfig)).rejects.toThrow(NarsilError)
    })

    it('rejects index names with special characters', async () => {
      await expect(narsil.createIndex('my index!', indexConfig)).rejects.toThrow(NarsilError)
    })

    it('rejects index names with path traversal', async () => {
      await expect(narsil.createIndex('foo..bar', indexConfig)).rejects.toThrow(NarsilError)
    })

    it('rejects index names starting with non-alphanumeric', async () => {
      await expect(narsil.createIndex('.hidden', indexConfig)).rejects.toThrow(NarsilError)
    })

    it('accepts valid index names', async () => {
      await narsil.createIndex('my-index_v2.1', indexConfig)
      const indexes = narsil.listIndexes()
      expect(indexes.map(i => i.name)).toContain('my-index_v2.1')
    })
  })

  describe('operations after shutdown', () => {
    it('throws on insert after shutdown', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.shutdown()

      await expect(narsil.insert('products', { title: 'Too Late', category: 'test', price: 1 })).rejects.toThrow(
        NarsilError,
      )
    })

    it('throws on query after shutdown', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.shutdown()

      await expect(narsil.query('products', { term: 'anything' })).rejects.toThrow(NarsilError)
    })

    it('throws on createIndex after shutdown', async () => {
      await narsil.shutdown()
      await expect(narsil.createIndex('new-index', indexConfig)).rejects.toThrow(NarsilError)
    })
  })

  describe('limit and offset clamping', () => {
    it('clamps limit to [0, 10000] and offset to [0, 100000]', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Test Item', category: 'test', price: 10 })

      const result = await narsil.query('products', {
        term: 'test',
        limit: 999999,
        offset: -5,
      })
      expect(result.hits.length).toBeLessThanOrEqual(10000)

      const result2 = await narsil.query('products', {
        term: 'test',
        limit: -1,
      })
      expect(result2.hits).toEqual([])
    })
  })

  describe('query with sorting', () => {
    it('sorts results by a numeric field', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Cheap Earbuds', category: 'electronics', price: 15 }, 'cheap')
      await narsil.insert('products', { title: 'Premium Earbuds', category: 'electronics', price: 200 }, 'premium')
      await narsil.insert('products', { title: 'Mid Earbuds', category: 'electronics', price: 75 }, 'mid')

      const result = await narsil.query('products', {
        term: 'earbuds',
        sort: { price: 'asc' },
      })

      expect(result.hits.length).toBe(3)
      const prices = result.hits.map(h => (h.document as Record<string, unknown>).price as number)
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1])
      }
    })
  })

  describe('query with grouping', () => {
    it('groups results by a field', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Wireless Mouse', category: 'electronics', price: 25 })
      await narsil.insert('products', { title: 'Wireless Keyboard', category: 'electronics', price: 45 })
      await narsil.insert('products', { title: 'Wireless Charger', category: 'accessories', price: 20 })

      const result = await narsil.query('products', {
        term: 'wireless',
        group: { fields: ['category'] },
      })

      expect(result.groups).toBeDefined()
      const groups = result.groups ?? []
      expect(groups.length).toBeGreaterThan(0)

      const groupValues = groups.map(g => g.values.category)
      expect(groupValues).toContain('electronics')
    })
  })

  describe('query with pagination and cursor', () => {
    it('paginates results using offset', async () => {
      await narsil.createIndex('products', indexConfig)

      for (let i = 0; i < 5; i++) {
        await narsil.insert('products', {
          title: `Wireless Device ${i}`,
          category: 'electronics',
          price: 10 + i,
        })
      }

      const page1 = await narsil.query('products', { term: 'wireless', limit: 2, offset: 0 })
      expect(page1.hits.length).toBe(2)
      expect(page1.count).toBe(5)

      const page2 = await narsil.query('products', { term: 'wireless', limit: 2, offset: 2 })
      expect(page2.hits.length).toBe(2)

      const page1Ids = new Set(page1.hits.map(h => h.id))
      for (const hit of page2.hits) {
        expect(page1Ids.has(hit.id)).toBe(false)
      }
    })

    it('returns a cursor when more results exist beyond the current page', async () => {
      await narsil.createIndex('products', indexConfig)

      for (let i = 0; i < 5; i++) {
        await narsil.insert('products', {
          title: `Wireless Device ${i}`,
          category: 'electronics',
          price: 10 + i,
        })
      }

      const result = await narsil.query('products', { term: 'wireless', limit: 2 })
      expect(result.hits.length).toBe(2)
      expect(result.cursor).toBeDefined()

      const lastPage = await narsil.query('products', { term: 'wireless', limit: 10 })
      expect(lastPage.cursor).toBeUndefined()
    })
  })

  describe('query with highlighting', () => {
    it('returns highlight snippets for matched terms', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', {
        title: 'Noise Cancelling Wireless Headphones',
        category: 'electronics',
        price: 199,
      })

      const result = await narsil.query('products', {
        term: 'wireless',
        highlight: { fields: ['title'] },
      })

      expect(result.hits.length).toBe(1)
      const highlights = result.hits[0].highlights
      expect(highlights).toBeDefined()
      expect(highlights?.title).toBeDefined()
      expect(highlights?.title.snippet).toContain('<mark>')
    })
  })

  describe('query with pinning', () => {
    it('pins a specific document at a given position', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert(
        'products',
        {
          title: 'Standard Headphones',
          category: 'electronics',
          price: 30,
        },
        'standard',
      )
      await narsil.insert(
        'products',
        {
          title: 'Premium Headphones Model',
          category: 'electronics',
          price: 250,
        },
        'premium',
      )
      await narsil.insert(
        'products',
        {
          title: 'Budget Headphones',
          category: 'electronics',
          price: 15,
        },
        'budget',
      )

      const result = await narsil.query('products', {
        term: 'headphones',
        pinned: [{ docId: 'budget', position: 0 }],
      })

      expect(result.hits.length).toBeGreaterThan(0)
      expect(result.hits[0].id).toBe('budget')
    })
  })

  describe('query with facets', () => {
    it('returns facet counts for a field', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'USB Cable', category: 'accessories', price: 5 })
      await narsil.insert('products', { title: 'USB Hub', category: 'electronics', price: 25 })
      await narsil.insert('products', { title: 'USB Charger', category: 'electronics', price: 15 })

      const result = await narsil.query('products', {
        term: 'usb',
        facets: { category: {} },
      })

      const facets = result.facets
      expect(facets).toBeDefined()
      expect(facets?.category).toBeDefined()
      expect(facets?.category.values).toBeDefined()
    })
  })

  describe('preflight', () => {
    it('returns count and elapsed without building full hits', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Fast Charger', category: 'electronics', price: 30 })
      await narsil.insert('products', { title: 'Slow Charger', category: 'electronics', price: 10 })

      const result = await narsil.preflight('products', { term: 'charger' })
      expect(result.count).toBe(2)
      expect(result.elapsed).toBeGreaterThanOrEqual(0)
    })
  })

  describe('getMultiple', () => {
    it('returns a Map of existing documents', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Item A', category: 'test', price: 10 }, 'a')
      await narsil.insert('products', { title: 'Item B', category: 'test', price: 20 }, 'b')

      const result = await narsil.getMultiple('products', ['a', 'b', 'nonexistent'])
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(2)
      expect(result.get('a')).toBeDefined()
      expect(result.get('b')).toBeDefined()
      expect(result.has('nonexistent')).toBe(false)
    })
  })

  describe('countDocuments', () => {
    it('returns the correct document count', async () => {
      await narsil.createIndex('products', indexConfig)

      const count0 = await narsil.countDocuments('products')
      expect(count0).toBe(0)

      await narsil.insert('products', { title: 'First', category: 'test', price: 1 })
      await narsil.insert('products', { title: 'Second', category: 'test', price: 2 })

      const count2 = await narsil.countDocuments('products')
      expect(count2).toBe(2)
    })
  })

  describe('clear', () => {
    it('empties the index without dropping it', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Temporary', category: 'test', price: 5 })

      const before = await narsil.countDocuments('products')
      expect(before).toBe(1)

      await narsil.clear('products')

      const after = await narsil.countDocuments('products')
      expect(after).toBe(0)

      const indexes = narsil.listIndexes()
      expect(indexes.map(i => i.name)).toContain('products')
    })
  })

  describe('getStats', () => {
    it('returns correct statistics for an index', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Widget', category: 'tools', price: 12 })
      await narsil.insert('products', { title: 'Gadget', category: 'tools', price: 24 })

      const stats = narsil.getStats('products')
      expect(stats.documentCount).toBe(2)
      expect(stats.partitionCount).toBeGreaterThanOrEqual(1)
      expect(stats.language).toBe('english')
      expect(stats.schema).toEqual(schema)
    })
  })

  describe('listIndexes', () => {
    it('lists all created indexes with metadata', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.createIndex('users', {
        schema: { name: 'string' as const },
        language: 'english',
      })

      const indexes = narsil.listIndexes()
      expect(indexes.length).toBe(2)

      const names = indexes.map(i => i.name)
      expect(names).toContain('products')
      expect(names).toContain('users')

      const productsInfo = indexes.find(i => i.name === 'products')
      expect(productsInfo?.language).toBe('english')
    })
  })

  describe('dropIndex', () => {
    it('removes an index from the registry', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'To Drop', category: 'test', price: 1 })

      await narsil.dropIndex('products')

      const indexes = narsil.listIndexes()
      expect(indexes.map(i => i.name)).not.toContain('products')

      await expect(narsil.insert('products', { title: 'After Drop', category: 'test', price: 1 })).rejects.toThrow(
        NarsilError,
      )
    })
  })

  describe('duplicate index creation', () => {
    it('throws INDEX_ALREADY_EXISTS when creating a duplicate index', async () => {
      await narsil.createIndex('products', indexConfig)

      try {
        await narsil.createIndex('products', indexConfig)
        expect.fail('Expected an error for duplicate index creation')
      } catch (err) {
        expect(err).toBeInstanceOf(NarsilError)
        expect((err as NarsilError).code).toBe(ErrorCodes.INDEX_ALREADY_EXISTS)
      }
    })
  })

  describe('getMemoryStats', () => {
    it('returns a valid memory stats structure', () => {
      const stats = narsil.getMemoryStats()
      expect(stats.totalBytes).toBe(0)
      expect(stats.workers).toEqual([])
    })
  })

  describe('custom docId', () => {
    it('uses a provided docId and validates it', async () => {
      await narsil.createIndex('products', indexConfig)

      const id = await narsil.insert('products', { title: 'Named Item', category: 'test', price: 42 }, 'my-custom-id')
      expect(id).toBe('my-custom-id')

      const doc = await narsil.get('products', 'my-custom-id')
      expect(doc?.title).toBe('Named Item')
    })

    it('rejects empty docId', async () => {
      await narsil.createIndex('products', indexConfig)

      await expect(narsil.insert('products', { title: 'No ID', category: 'test', price: 1 }, '')).rejects.toThrow(
        NarsilError,
      )
    })
  })

  describe('has', () => {
    it('returns true for existing documents and false for missing ones', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Existing', category: 'test', price: 1 }, 'exists')

      expect(await narsil.has('products', 'exists')).toBe(true)
      expect(await narsil.has('products', 'missing')).toBe(false)
    })
  })

  describe('removeBatch', () => {
    it('removes multiple documents and reports failures', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'One', category: 'test', price: 1 }, 'r1')
      await narsil.insert('products', { title: 'Two', category: 'test', price: 2 }, 'r2')

      const result = await narsil.removeBatch('products', ['r1', 'r2', 'nonexistent'])
      expect(result.succeeded.length).toBe(2)
      expect(result.failed.length).toBe(1)
      expect(result.failed[0].docId).toBe('nonexistent')
    })
  })

  describe('updateBatch', () => {
    it('updates multiple documents and reports failures', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Original One', category: 'test', price: 1 }, 'u1')
      await narsil.insert('products', { title: 'Original Two', category: 'test', price: 2 }, 'u2')

      const result = await narsil.updateBatch('products', [
        { docId: 'u1', document: { title: 'Updated One', category: 'test', price: 11 } },
        { docId: 'u2', document: { title: 'Updated Two', category: 'test', price: 22 } },
        { docId: 'missing', document: { title: 'Ghost', category: 'test', price: 0 } },
      ])

      expect(result.succeeded.length).toBe(2)
      expect(result.failed.length).toBe(1)
      expect(result.failed[0].docId).toBe('missing')

      const doc = await narsil.get('products', 'u1')
      expect(doc?.title).toBe('Updated One')
    })
  })
})
