import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Narsil } from '../../narsil'
import { createNarsil } from '../../narsil'

const distEntry = new URL('../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

const BATCH_SIZE = 500
const PROMOTION_POLL_MS = 50
const PROMOTION_ATTEMPTS = 200

function batchDocuments(count: number, marker: string): Array<Record<string, unknown>> {
  const words = ['alpha', 'beta', 'gamma', 'delta']
  return Array.from({ length: count }, (_, i) => ({
    id: `${marker}-${String(i).padStart(4, '0')}`,
    title: `${marker} ${words[i % words.length]} ${words[(i + 2) % words.length]}`,
    price: i,
  }))
}

async function waitForWorkers(narsil: Narsil): Promise<number> {
  for (let attempt = 0; attempt < PROMOTION_ATTEMPTS; attempt++) {
    const stats = await narsil.getMemoryStats()
    if (stats.workers.length > 0) return stats.workers.length
    await new Promise<void>(resolve => setTimeout(resolve, PROMOTION_POLL_MS))
  }
  return 0
}

async function promotedEngine(): Promise<Narsil> {
  const narsil = await createNarsil({ workers: { enabled: true, count: 2, promotionThreshold: 2 } })
  await narsil.createIndex('prose', { schema: { title: 'string', price: 'number' }, language: 'english' })
  await narsil.insertBatch('prose', batchDocuments(4, 'seed'))
  expect(await waitForWorkers(narsil)).toBeGreaterThan(0)
  return narsil
}

describe.skipIf(!built)('a promoted index takes a large batch through built segments', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('leaves the worker copies holding what a document-by-document insert would have', async () => {
    const narsil = await promotedEngine()

    await narsil.insertBatch('prose', batchDocuments(BATCH_SIZE, 'bulk'))

    expect(await narsil.countDocuments('prose')).toBe(BATCH_SIZE + 4)

    const bulkHits = await narsil.query('prose', { term: 'bulk', limit: BATCH_SIZE })
    expect(bulkHits.hits.length).toBe(BATCH_SIZE)

    const termHits = await narsil.query('prose', { term: 'gamma', limit: BATCH_SIZE + 4 })
    expect(termHits.hits.length).toBeGreaterThan(0)
    for (const hit of termHits.hits) {
      expect(String(hit.document.title)).toContain('gamma')
    }

    const filtered = await narsil.query('prose', {
      term: 'bulk',
      filters: { fields: { price: { lt: 10 } } },
      limit: BATCH_SIZE,
    })
    expect(filtered.hits.length).toBe(10)

    expect(await narsil.get('prose', 'bulk-0100')).toBeDefined()

    await narsil.shutdown()
  }, 120000)

  it('scores a term the same whether the batch went through segments or one at a time', async () => {
    const segmented = await promotedEngine()
    await segmented.insertBatch('prose', batchDocuments(BATCH_SIZE, 'bulk'))
    const segmentedHits = await segmented.query('prose', { term: 'alpha', limit: 20 })

    const sequential = await createNarsil()
    await sequential.createIndex('prose', { schema: { title: 'string', price: 'number' }, language: 'english' })
    await sequential.insertBatch('prose', batchDocuments(4, 'seed'))
    for (const document of batchDocuments(BATCH_SIZE, 'bulk')) {
      await sequential.insert('prose', document)
    }
    const sequentialHits = await sequential.query('prose', { term: 'alpha', limit: 20 })

    expect(segmentedHits.hits.map(hit => hit.id)).toEqual(sequentialHits.hits.map(hit => hit.id))
    expect(segmentedHits.hits.map(hit => hit.score)).toEqual(sequentialHits.hits.map(hit => hit.score))

    await segmented.shutdown()
    await sequential.shutdown()
  }, 120000)

  it('keeps removals and re-inserts working after a segmented batch', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    const narsil = await promotedEngine()
    await narsil.insertBatch('prose', batchDocuments(BATCH_SIZE, 'bulk'))

    await narsil.remove('prose', 'bulk-0007')
    expect(await narsil.countDocuments('prose')).toBe(BATCH_SIZE + 3)
    expect(await narsil.get('prose', 'bulk-0007')).toBeUndefined()

    await narsil.insert('prose', { id: 'bulk-0007', title: 'bulk gamma returned', price: 7 })
    expect(await narsil.countDocuments('prose')).toBe(BATCH_SIZE + 4)

    const replicationWarnings = warnSpy.mock.calls.filter(call => String(call[0]).includes('Worker replication failed'))
    expect(replicationWarnings).toEqual([])

    await narsil.shutdown()
  }, 120000)

  it('keeps a batch below the segment threshold on the document-by-document path', async () => {
    const narsil = await promotedEngine()

    await narsil.insertBatch('prose', batchDocuments(10, 'small'))

    expect(await narsil.countDocuments('prose')).toBe(14)
    const hits = await narsil.query('prose', { term: 'small', limit: 20 })
    expect(hits.hits.length).toBe(10)

    await narsil.shutdown()
  }, 120000)
})
