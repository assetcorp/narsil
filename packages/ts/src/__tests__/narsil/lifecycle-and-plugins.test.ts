import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilPlugin } from '../../types/plugins'
import { indexConfig } from './fixtures'

describe('Narsil lifecycle and plugin hooks', () => {
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
})
