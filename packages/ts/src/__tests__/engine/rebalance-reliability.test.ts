import type { Dirent } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexConfig } from '../../types/schema'
import { createMockAdapter } from '../embedding/fixtures'

const schema = { title: 'string' as const, category: 'string' as const }

const indexConfig: IndexConfig = { schema, language: 'english' }

function seedDocs(count: number): Array<Record<string, unknown>> {
  const docs: Array<Record<string, unknown>> = []
  for (let i = 0; i < count; i++) {
    docs.push({ id: `seed-${i}`, title: `wireless device ${i}`, category: `cat-${i % 5}` })
  }
  return docs
}

async function walHoldsDocId(dir: string, indexName: string, docId: string): Promise<boolean> {
  const walRoot = join(dir, indexName, 'wal')
  const stack = [walRoot]
  const needle = Buffer.from(docId, 'utf8')
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else {
        const bytes = await readFile(full)
        if (bytes.includes(needle)) return true
      }
    }
  }
  return false
}

describe('rebalance write buffering', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('keeps a batch insert issued during a rebalance', async () => {
    await narsil.createIndex('products', indexConfig)
    await narsil.insertBatch('products', seedDocs(2500))

    const rebalancePromise = narsil.rebalance('products', 3)
    const batch = await narsil.insertBatch('products', [
      { id: 'during-batch-0', title: 'buffered batch alpha', category: 'during' },
      { id: 'during-batch-1', title: 'buffered batch beta', category: 'during' },
    ])
    await rebalancePromise

    expect(batch.failed).toHaveLength(0)
    expect(await narsil.countDocuments('products')).toBe(2502)
    expect(await narsil.get('products', 'during-batch-0')).toBeDefined()
    expect(await narsil.get('products', 'during-batch-1')).toBeDefined()
    expect((await narsil.query('products', { term: 'buffered' })).count).toBe(2)
  })

  it('applies an update of a missing document during a rebalance as an insert', async () => {
    await narsil.createIndex('products', indexConfig)
    await narsil.insertBatch('products', seedDocs(2500))

    const rebalancePromise = narsil.rebalance('products', 2)
    await narsil.update('products', 'never-inserted', { title: 'upserted title', category: 'during' })
    await rebalancePromise

    expect(await narsil.get('products', 'never-inserted')).toBeDefined()
    expect((await narsil.query('products', { term: 'upserted' })).count).toBe(1)
  })

  it('fires afterInsert for a write buffered during a rebalance exactly once', async () => {
    const afterInsertIds: string[] = []
    const hooked = await createNarsil({
      plugins: [
        {
          name: 'after-insert-recorder',
          afterInsert({ docId }) {
            afterInsertIds.push(docId)
          },
        },
      ],
    })
    try {
      await hooked.createIndex('products', indexConfig)
      await hooked.insertBatch('products', seedDocs(2500))
      afterInsertIds.length = 0

      const rebalancePromise = hooked.rebalance('products', 2)
      await hooked.insert('products', { id: 'hooked-doc', title: 'hook subject', category: 'during' })
      await rebalancePromise

      expect(afterInsertIds).toEqual(['hooked-doc'])
    } finally {
      await hooked.shutdown()
    }
  })

  it('embeds a document inserted during a rebalance', async () => {
    const adapter = createMockAdapter(8)
    const embedded = await createNarsil()
    try {
      await embedded.createIndex('articles', {
        schema: { title: 'string', embedding: 'vector[8]' },
        embedding: { adapter, fields: { embedding: ['title'] } },
      })
      const docs: Array<Record<string, unknown>> = []
      for (let i = 0; i < 2500; i++) {
        docs.push({ id: `seed-${i}`, title: `article number ${i}` })
      }
      await embedded.insertBatch('articles', docs)

      const rebalancePromise = embedded.rebalance('articles', 2)
      await embedded.insert('articles', { id: 'embedded-during', title: 'buffered embedding subject' })
      await rebalancePromise

      const stored = await embedded.get('articles', 'embedded-during')
      expect(stored).toBeDefined()
      expect(stored?.embedding).toBeInstanceOf(Float32Array)
      expect((stored?.embedding as Float32Array).length).toBe(8)
    } finally {
      await embedded.shutdown()
    }
  })

  it('enforces capacity for writes issued during a rebalance', async () => {
    await narsil.createIndex('bounded', {
      schema,
      partitions: { maxDocsPerPartition: 2500 },
    })
    await narsil.insertBatch('bounded', seedDocs(2500))

    const rebalancePromise = narsil.rebalance('bounded', 2)
    await expect(
      narsil.insert('bounded', { id: 'over-capacity', title: 'rejected', category: 'during' }),
    ).rejects.toMatchObject({ code: ErrorCodes.PARTITION_CAPACITY_EXCEEDED })
    await rebalancePromise

    expect(await narsil.countDocuments('bounded')).toBe(2500)
  })

  it('rebalances two indexes concurrently', async () => {
    await narsil.createIndex('left', indexConfig)
    await narsil.createIndex('right', indexConfig)
    await narsil.insertBatch('left', seedDocs(1200))
    await narsil.insertBatch('right', seedDocs(1200))

    await Promise.all([narsil.rebalance('left', 2), narsil.rebalance('right', 3)])

    expect(narsil.getStats('left').partitionCount).toBe(2)
    expect(narsil.getStats('right').partitionCount).toBe(3)
    expect(await narsil.countDocuments('left')).toBe(1200)
    expect(await narsil.countDocuments('right')).toBe(1200)
  })

  it('emits partitionWatermark once per capacity level', async () => {
    const events: Array<{ documentCount: number; capacity: number; partitionCount: number }> = []
    narsil.on('partitionWatermark', payload => {
      events.push({
        documentCount: payload.documentCount,
        capacity: payload.capacity,
        partitionCount: payload.partitionCount,
      })
    })

    await narsil.createIndex('watched', {
      schema,
      partitions: { maxDocsPerPartition: 100, watermark: 0.8 },
    })

    await narsil.insertBatch('watched', seedDocs(79))
    expect(events).toHaveLength(0)

    await narsil.insert('watched', { id: 'crossing', title: 'crossing doc', category: 'edge' })
    expect(events).toHaveLength(1)
    expect(events[0].capacity).toBe(100)
    expect(events[0].partitionCount).toBe(1)

    await narsil.insert('watched', { id: 'beyond', title: 'beyond doc', category: 'edge' })
    expect(events).toHaveLength(1)

    await narsil.rebalance('watched', 2)
    await narsil.insertBatch(
      'watched',
      Array.from({ length: 79 }, (_, i) => ({ id: `second-${i}`, title: `filler ${i}`, category: 'edge' })),
    )
    expect(events).toHaveLength(2)
    expect(events[1].capacity).toBe(200)
    expect(events[1].partitionCount).toBe(2)
  })
})

describe('rebalance durability', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-rebalance-durability-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  it(
    'appends a write buffered during a rebalance to the write-ahead log before acknowledging it',
    { timeout: 30_000 },
    async () => {
      engine = await createNarsil({ durability: { directory: dir, mode: 'sync' } })
      await engine.createIndex('products', indexConfig)
      await engine.insertBatch('products', seedDocs(300))

      const rebalancePromise = engine.rebalance('products', 2)
      await engine.insert('products', {
        id: 'acknowledged-mid-rebalance',
        title: 'durable subject',
        category: 'during',
      })
      expect(await walHoldsDocId(dir, 'products', 'acknowledged-mid-rebalance')).toBe(true)
      await rebalancePromise
    },
  )

  it('recovers the buffered write and the new partition count after a crash', { timeout: 30_000 }, async () => {
    engine = await createNarsil({ durability: { directory: dir, mode: 'sync' } })
    await engine.createIndex('products', indexConfig)
    await engine.insertBatch('products', seedDocs(300))

    const rebalancePromise = engine.rebalance('products', 2)
    await engine.insert('products', { id: 'crash-survivor', title: 'crash subject', category: 'during' })
    await rebalancePromise

    const abandoned = engine
    engine = await createNarsil({ durability: { directory: dir, mode: 'sync' } })

    expect(await engine.countDocuments('products')).toBe(301)
    expect(narsilStatsPartitionCount(engine)).toBe(2)
    expect(await engine.get('products', 'crash-survivor')).toBeDefined()

    await abandoned.shutdown()
  })

  it('persists an updated partition configuration across recovery', async () => {
    engine = await createNarsil({ durability: { directory: dir, mode: 'sync' } })
    await engine.createIndex('products', {
      schema,
      partitions: { maxDocsPerPartition: 5000, maxPartitions: 1, watermark: 0.5 },
    })
    await engine.insert('products', { id: 'only', title: 'single doc', category: 'solo' })
    await engine.updatePartitionConfig('products', { maxPartitions: 3, watermark: 0.9 })
    await engine.shutdown()

    engine = await createNarsil({ durability: { directory: dir, mode: 'sync' } })
    await engine.updatePartitionConfig('products', {})
    await expect(engine.rebalance('products', 4)).rejects.toThrow('above the maximum of 3 partitions')
    await engine.rebalance('products', 3)
    expect(narsilStatsPartitionCount(engine)).toBe(3)
  })
})

function narsilStatsPartitionCount(engine: Narsil): number {
  return engine.getStats('products').partitionCount
}

describe('rebalance guards', () => {
  it('throws NarsilError with PARTITION_CAPACITY_EXCEEDED above maxPartitions', async () => {
    const narsil = await createNarsil()
    try {
      await narsil.createIndex('capped', { schema, partitions: { maxPartitions: 2 } })
      await narsil.insert('capped', { id: 'one', title: 'single', category: 'solo' })
      let thrown: unknown
      try {
        await narsil.rebalance('capped', 3)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(NarsilError)
      expect((thrown as NarsilError).code).toBe(ErrorCodes.PARTITION_CAPACITY_EXCEEDED)
    } finally {
      await narsil.shutdown()
    }
  })

  it('rejects an invalid watermark at index creation and on update', async () => {
    const narsil = await createNarsil()
    try {
      await expect(
        narsil.createIndex('badwatermark', { schema, partitions: { watermark: 1.5 } }),
      ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })

      await narsil.createIndex('goodwatermark', { schema, partitions: { maxDocsPerPartition: 10 } })
      await expect(narsil.updatePartitionConfig('goodwatermark', { watermark: 0 })).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
      })
    } finally {
      await narsil.shutdown()
    }
  })
})
