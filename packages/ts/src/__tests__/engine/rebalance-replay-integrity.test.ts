import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexConfig } from '../../types/schema'

const schema = { title: 'string' as const, category: 'string' as const }

const indexConfig: IndexConfig = { schema, language: 'english' }

function seedDocs(count: number): Array<Record<string, unknown>> {
  const docs: Array<Record<string, unknown>> = []
  for (let i = 0; i < count; i++) {
    docs.push({ id: `seed-${i}`, title: `wireless device ${i}`, category: `cat-${i % 5}` })
  }
  return docs
}

describe('rebalance replay integrity', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('keeps a write buffered during a second rebalance of the same index', async () => {
    await narsil.createIndex('products', indexConfig)
    await narsil.insertBatch('products', seedDocs(2500))

    const firstRebalance = narsil.rebalance('products', 2)
    await narsil.insert('products', { id: 'first-run-buffered', title: 'first run subject', category: 'during' })
    await firstRebalance

    expect(await narsil.get('products', 'first-run-buffered')).toBeDefined()

    const secondRebalance = narsil.rebalance('products', 3)
    await narsil.insert('products', { id: 'second-run-buffered', title: 'second run subject', category: 'during' })
    await secondRebalance

    expect(await narsil.get('products', 'second-run-buffered')).toBeDefined()
    expect(await narsil.countDocuments('products')).toBe(2502)
    expect((await narsil.query('products', { term: 'subject' })).count).toBe(2)
  })

  it('keeps writes admitted during a rebalance that lowers the partition count', async () => {
    await narsil.createIndex('bounded', {
      schema,
      partitions: { maxDocsPerPartition: 100, maxPartitions: 4 },
    })
    await narsil.insertBatch('bounded', seedDocs(190))

    const rebalancePromise = narsil.rebalance('bounded', 2)
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, (_, i) =>
        narsil.insert('bounded', { id: `during-${i}`, title: `shrink subject ${i}`, category: 'during' }),
      ),
    )
    await rebalancePromise

    const acknowledged = results.filter(r => r.status === 'fulfilled').length
    expect(await narsil.countDocuments('bounded')).toBe(190 + acknowledged)
    expect(190 + acknowledged).toBeLessThanOrEqual(200)
  })

  it('rejects an insert of an existing document id during a rebalance', async () => {
    await narsil.createIndex('products', indexConfig)
    await narsil.insertBatch('products', seedDocs(2500))

    const rebalancePromise = narsil.rebalance('products', 2)
    await expect(
      narsil.insert('products', { id: 'seed-0', title: 'duplicate subject', category: 'during' }),
    ).rejects.toMatchObject({ code: ErrorCodes.DOC_ALREADY_EXISTS })
    await rebalancePromise

    expect(await narsil.countDocuments('products')).toBe(2500)
  })

  it('rejects a maxPartitions update below the current partition count', async () => {
    await narsil.createIndex('products', { schema, partitions: { maxPartitions: 4 } })
    await narsil.insert('products', { id: 'one', title: 'single', category: 'solo' })

    await expect(narsil.updatePartitionConfig('products', { maxPartitions: 2 })).rejects.toMatchObject({
      code: ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
    })

    await narsil.updatePartitionConfig('products', { maxPartitions: 4 })
  })
})
