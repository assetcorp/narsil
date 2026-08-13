import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil } from '../../narsil'

const distEntry = new URL('../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

function proseDocuments(count: number, marker: string): Array<Record<string, unknown>> {
  const words = ['alpha', 'beta', 'gamma', 'delta']
  return Array.from({ length: count }, (_, i) => ({
    id: `${marker}-${String(i).padStart(4, '0')}`,
    title: `${marker} ${words[i % words.length]} ${words[(i + 2) % words.length]}`,
    price: i,
  }))
}

describe.skipIf(!built)('a large batch lands on worker copies before the per-index threshold', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('promotes ahead of the batch instead of partway through it', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    const narsil = await createNarsil({ workers: { enabled: true, count: 2, promotionThreshold: 100 } })
    await narsil.createIndex('prose', { schema: { title: 'string', price: 'number' }, language: 'english' })

    const result = await narsil.insertBatch('prose', proseDocuments(200, 'bulk'))
    expect(result.succeeded).toHaveLength(200)
    expect(result.failed).toHaveLength(0)

    const stats = await narsil.getMemoryStats()
    expect(stats.workers.length).toBe(2)

    expect(await narsil.countDocuments('prose')).toBe(200)
    const hits = await narsil.query('prose', { term: 'bulk', limit: 200 })
    expect(hits.hits.length).toBe(200)

    await narsil.shutdown()

    const replicationWarnings = warnSpy.mock.calls.filter(call => String(call[0]).includes('Worker replication failed'))
    expect(replicationWarnings).toEqual([])
  }, 120000)

  it('answers a query with every document the moment the batch resolves', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    const narsil = await createNarsil({ workers: { enabled: true, count: 2, promotionThreshold: 100 } })
    await narsil.createIndex('prose', { schema: { title: 'string', price: 'number' }, language: 'english' })

    const result = await narsil.insertBatch('prose', proseDocuments(300, 'fresh'))
    expect(result.succeeded).toHaveLength(300)

    const hits = await narsil.query('prose', { term: 'fresh', limit: 300 })
    expect(hits.hits.length).toBe(300)

    await narsil.shutdown()

    const replicationWarnings = warnSpy.mock.calls.filter(call => String(call[0]).includes('Worker replication failed'))
    expect(replicationWarnings).toEqual([])
  }, 120000)

  it('leaves promotion alone when the batch stays under the threshold', async () => {
    const narsil = await createNarsil({ workers: { enabled: true, count: 2, promotionThreshold: 500 } })
    await narsil.createIndex('prose', { schema: { title: 'string', price: 'number' }, language: 'english' })

    await narsil.insertBatch('prose', proseDocuments(100, 'small'))

    const stats = await narsil.getMemoryStats()
    expect(stats.workers.length).toBe(0)
    expect(await narsil.countDocuments('prose')).toBe(100)

    await narsil.shutdown()
  }, 120000)
})

describe.skipIf(!built)('a segmented batch keeps the per-document contract', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fails only the documents a strict schema rejects', async () => {
    const narsil = await createNarsil({ workers: { enabled: true, count: 2, promotionThreshold: 100 } })
    await narsil.createIndex('prose', {
      schema: { title: 'string', price: 'number' },
      language: 'english',
      strict: true,
    })

    const documents = proseDocuments(200, 'bulk')
    documents[17] = { ...documents[17], stray: 'not in the schema' }
    documents[90] = { ...documents[90], stray: 'not in the schema' }

    const result = await narsil.insertBatch('prose', documents)
    expect((await narsil.getMemoryStats()).workers.length).toBe(2)
    expect(result.failed).toHaveLength(2)
    expect(result.failed.map(entry => entry.docId).sort()).toEqual(['bulk-0017', 'bulk-0090'])
    for (const entry of result.failed) {
      expect(entry.error).toBeInstanceOf(NarsilError)
    }
    expect(result.succeeded).toHaveLength(198)
    expect(await narsil.countDocuments('prose')).toBe(198)
    expect(await narsil.get('prose', 'bulk-0017')).toBeUndefined()

    await narsil.shutdown()
  }, 120000)

  it('fails a duplicate inside the batch and keeps its first occurrence', async () => {
    const narsil = await createNarsil({ workers: { enabled: true, count: 2, promotionThreshold: 100 } })
    await narsil.createIndex('prose', { schema: { title: 'string', price: 'number' }, language: 'english' })

    const documents = proseDocuments(200, 'bulk')
    documents[150] = { ...documents[150], id: 'bulk-0003', title: 'bulk duplicate late' }

    const result = await narsil.insertBatch('prose', documents)
    expect((await narsil.getMemoryStats()).workers.length).toBe(2)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].docId).toBe('bulk-0003')
    expect((result.failed[0].error as NarsilError).code).toBe(ErrorCodes.DOC_ALREADY_EXISTS)
    expect(result.succeeded).toHaveLength(199)
    expect(await narsil.countDocuments('prose')).toBe(199)
    expect(await narsil.get('prose', 'bulk-0003')).toMatchObject({ price: 3 })

    await narsil.shutdown()
  }, 120000)

  it('stops admitting documents at the partition capacity', async () => {
    const narsil = await createNarsil({ workers: { enabled: true, count: 2, promotionThreshold: 50 } })
    await narsil.createIndex('prose', {
      schema: { title: 'string', price: 'number' },
      language: 'english',
      partitions: { maxPartitions: 1, maxDocsPerPartition: 100 },
    })

    const result = await narsil.insertBatch('prose', proseDocuments(150, 'bulk'))
    expect((await narsil.getMemoryStats()).workers.length).toBe(2)
    expect(result.succeeded).toHaveLength(100)
    expect(result.failed).toHaveLength(50)
    for (const entry of result.failed) {
      expect((entry.error as NarsilError).code).toBe(ErrorCodes.PARTITION_CAPACITY_EXCEEDED)
    }
    expect(await narsil.countDocuments('prose')).toBe(100)

    await narsil.shutdown()
  }, 120000)
})

describe.skipIf(!built)('a segmented batch carries the index analysis options', () => {
  it('collects surface forms for suggestions', async () => {
    const narsil = await createNarsil({ workers: { enabled: true, count: 2, promotionThreshold: 100 } })
    await narsil.createIndex('prose', {
      schema: { title: 'string', price: 'number' },
      language: 'english',
      surfaceForms: true,
    })

    await narsil.insertBatch('prose', proseDocuments(200, 'bulk'))
    expect((await narsil.getMemoryStats()).workers.length).toBe(2)

    const suggestions = await narsil.suggest('prose', { prefix: 'gam' })
    expect(suggestions.terms.map(entry => entry.term)).toContain('gamma')

    await narsil.shutdown()
  }, 120000)

  it('applies a stop word list from the index config', async () => {
    const narsil = await createNarsil({ workers: { enabled: true, count: 2, promotionThreshold: 100 } })
    await narsil.createIndex('prose', {
      schema: { title: 'string', price: 'number' },
      language: 'english',
      stopWords: new Set(['gamma']),
    })

    await narsil.insertBatch('prose', proseDocuments(200, 'bulk'))
    expect((await narsil.getMemoryStats()).workers.length).toBe(2)

    const stopped = await narsil.query('prose', { term: 'gamma', limit: 200 })
    expect(stopped.hits).toHaveLength(0)
    const kept = await narsil.query('prose', { term: 'alpha', limit: 200 })
    expect(kept.hits.length).toBeGreaterThan(0)

    await narsil.shutdown()
  }, 120000)
})

describe.skipIf(!built)('a segmented batch survives recovery from the write-ahead log', () => {
  it('replays every document the batch acknowledged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'narsil-segment-wal-'))
    try {
      const writer = await createNarsil({
        workers: { enabled: true, count: 2, promotionThreshold: 100 },
        durability: { directory: root },
      })
      await writer.createIndex('prose', { schema: { title: 'string', price: 'number' }, language: 'english' })
      const result = await writer.insertBatch('prose', proseDocuments(200, 'bulk'))
      expect((await writer.getMemoryStats()).workers.length).toBe(2)
      expect(result.succeeded).toHaveLength(200)
      await writer.shutdown()

      const reader = await createNarsil({ durability: { directory: root } })
      expect(await reader.countDocuments('prose')).toBe(200)
      const hits = await reader.query('prose', { term: 'bulk', limit: 200 })
      expect(hits.hits.length).toBe(200)
      expect(await reader.get('prose', 'bulk-0123')).toMatchObject({ price: 123 })
      await reader.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120000)
})
