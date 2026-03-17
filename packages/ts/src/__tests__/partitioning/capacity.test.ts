import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'

const schema: SchemaDefinition = {
  title: 'string' as const,
  price: 'number' as const,
}

describe('partition capacity enforcement', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('rejects inserts beyond the configured capacity', async () => {
    const config: IndexConfig = {
      schema,
      language: 'english',
      partitions: { maxDocsPerPartition: 5, maxPartitions: 2 },
    }
    await narsil.createIndex('limited', config)

    for (let i = 0; i < 10; i++) {
      await narsil.insert('limited', { title: `Item ${i}`, price: i })
    }

    expect(await narsil.countDocuments('limited')).toBe(10)

    try {
      await narsil.insert('limited', { title: 'Overflow', price: 999 })
      expect.fail('Expected capacity exceeded error')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.PARTITION_CAPACITY_EXCEEDED)
    }
  })

  it('allows inserts after removes free up capacity', async () => {
    const config: IndexConfig = {
      schema,
      language: 'english',
      partitions: { maxDocsPerPartition: 3, maxPartitions: 1 },
    }
    await narsil.createIndex('limited', config)

    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      ids.push(await narsil.insert('limited', { title: `Item ${i}`, price: i }))
    }

    await expect(narsil.insert('limited', { title: 'Overflow', price: 999 })).rejects.toThrow(NarsilError)

    await narsil.remove('limited', ids[0])
    const newId = await narsil.insert('limited', { title: 'Replacement', price: 100 })
    expect(newId).toBeTruthy()
    expect(await narsil.countDocuments('limited')).toBe(3)
  })

  it('reports partial success in batch insert when capacity is exceeded', async () => {
    const config: IndexConfig = {
      schema,
      language: 'english',
      partitions: { maxDocsPerPartition: 5, maxPartitions: 1 },
    }
    await narsil.createIndex('limited', config)

    for (let i = 0; i < 3; i++) {
      await narsil.insert('limited', { title: `Existing ${i}`, price: i })
    }

    const batchDocs = Array.from({ length: 10 }, (_, i) => ({
      title: `Batch ${i}`,
      price: i * 10,
    }))

    const result = await narsil.insertBatch('limited', batchDocs)
    expect(result.succeeded.length).toBe(2)
    expect(result.failed.length).toBe(8)
    for (const failure of result.failed) {
      expect(failure.error.code).toBe(ErrorCodes.PARTITION_CAPACITY_EXCEEDED)
    }
  })

  it('does not enforce limits when partition config is omitted', async () => {
    await narsil.createIndex('unlimited', { schema, language: 'english' })

    for (let i = 0; i < 50; i++) {
      await narsil.insert('unlimited', { title: `Item ${i}`, price: i })
    }

    expect(await narsil.countDocuments('unlimited')).toBe(50)
  })
})
