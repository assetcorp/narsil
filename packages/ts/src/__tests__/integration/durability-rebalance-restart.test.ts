import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import type { IndexConfig } from '../../types/schema'

const PRODUCT_SCHEMA: IndexConfig = {
  schema: { title: 'string', price: 'number' },
  language: 'english',
}

const DOCUMENT_COUNT = 400
const SPREAD_FLOOR = 20

describe('a restart on the write-ahead-log tier after a rebalance', { timeout: 30_000 }, () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-rebalance-restart-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function writeAndRebalance(targetPartitions: number, writesAfter: number): Promise<number> {
    const writer = await createNarsil({ durability: { directory: root, tier: 'wal' }, workers: { enabled: false } })
    await writer.createIndex('products', PRODUCT_SCHEMA)
    await writer.insertBatch(
      'products',
      Array.from({ length: DOCUMENT_COUNT }, (_, i) => ({ id: `p${i}`, title: `Product ${i}`, price: i })),
    )
    const before = writer.getPartitionStats('products').length
    await writer.rebalance('products', targetPartitions)
    for (let i = 0; i < writesAfter; i++) {
      await writer.insert('products', { title: `Later ${i}`, price: i }, `later${i}`)
    }
    await writer.shutdown()
    return before
  }

  it('recovers the new partition layout with every document in its new partition', async () => {
    const before = await writeAndRebalance(8, 0)
    expect(before).not.toBe(8)

    const reader = await createNarsil({ durability: { directory: root, tier: 'wal' }, workers: { enabled: false } })
    const stats = reader.getPartitionStats('products')
    expect(stats).toHaveLength(8)
    expect(Math.min(...stats.map(partition => partition.documentCount))).toBeGreaterThan(SPREAD_FLOOR)
    expect(await reader.countDocuments('products')).toBe(DOCUMENT_COUNT)
    expect((await reader.query('products', { term: 'product', limit: 0 })).count).toBe(DOCUMENT_COUNT)
    await reader.shutdown()
  })

  it('keeps the writes made after the rebalance in their new partitions', async () => {
    await writeAndRebalance(8, 40)

    const reader = await createNarsil({ durability: { directory: root, tier: 'wal' }, workers: { enabled: false } })
    const stats = reader.getPartitionStats('products')
    expect(stats).toHaveLength(8)
    expect(Math.min(...stats.map(partition => partition.documentCount))).toBeGreaterThan(SPREAD_FLOOR)
    expect(stats.reduce((sum, partition) => sum + partition.documentCount, 0)).toBe(DOCUMENT_COUNT + 40)
    expect(await reader.get('products', 'later39')).toMatchObject({ title: 'Later 39' })
    await reader.shutdown()
  })
})
