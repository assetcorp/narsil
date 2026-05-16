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
})
