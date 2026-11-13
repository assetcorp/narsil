import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { SchemaDefinition } from '../../types/schema'
import { indexConfig } from './fixtures'

describe('Narsil index validation, shutdown, and batch operations', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
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
        { id: 'bad-price', title: 'Invalid Item', price: 'not-a-number' as unknown as number },
      ]

      const result = await narsil.insertBatch('strict', documents)
      expect(result.succeeded.length).toBe(2)
      expect(result.failed.length).toBe(1)
      expect(result.failed[0].docId).toBe('bad-price')
    })

    it('carries provided document ids on failed entries for required-field violations', async () => {
      const schema: SchemaDefinition = {
        title: 'string' as const,
        price: 'number' as const,
      }

      await narsil.createIndex('inventory', { schema, language: 'english', required: ['price'] })

      const result = await narsil.insertBatch('inventory', [
        { id: 'has-price', title: 'Complete Item', price: 5 },
        { id: 'missing-price', title: 'Incomplete Item' },
        { title: 'Incomplete Item Without Id' },
      ])

      expect(result.succeeded).toEqual(['has-price'])
      expect(result.failed.length).toBe(2)
      expect(result.failed.map(entry => entry.docId).sort()).toEqual(['', 'missing-price'])
    })

    it('refuses a batch that is not an array, stores nothing, and keeps answering', async () => {
      await narsil.createIndex('products', indexConfig)
      await narsil.insert('products', { title: 'Kept Item', category: 'test', price: 1 }, 'kept')
      const notLists: unknown[] = ['Trackball mouse', 42, null, undefined, { length: 2, 0: { title: 'x' } }]

      for (const given of notLists) {
        await expect(narsil.insertBatch('products', given as [])).rejects.toMatchObject({
          code: 'DOC_VALIDATION_FAILED',
        })
        await expect(narsil.updateBatch('products', given as [])).rejects.toMatchObject({
          code: 'DOC_VALIDATION_FAILED',
        })
        await expect(narsil.removeBatch('products', given as [])).rejects.toMatchObject({
          code: 'DOC_VALIDATION_FAILED',
        })
      }

      expect(await narsil.countDocuments('products')).toBe(1)
      expect(await narsil.get('products', 'kept')).toMatchObject({ title: 'Kept Item' })
      const later = await narsil.insertBatch('products', [{ title: 'Later Item', category: 'test', price: 2 }])
      expect(later.succeeded.length).toBe(1)
      expect(await narsil.countDocuments('products')).toBe(2)
    })
  })

  describe('index name validation', () => {
    it('refuses an index name that could reach outside its directory', async () => {
      await expect(narsil.createIndex('foo..bar', indexConfig)).rejects.toThrow(NarsilError)
      await expect(narsil.createIndex('.hidden', indexConfig)).rejects.toThrow(NarsilError)
      await expect(narsil.createIndex('my index!', indexConfig)).rejects.toThrow(NarsilError)
    })
  })
})
