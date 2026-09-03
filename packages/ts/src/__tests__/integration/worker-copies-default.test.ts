import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import type { NarsilEventMap } from '../../types/events'
import type { QueryResult } from '../../types/results'
import type { QueryParams } from '../../types/search'

const distEntry = new URL('../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

const COPY_THRESHOLD = 1_000
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
const CATEGORIES = ['books', 'music', 'film']

function corpus(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${String(i).padStart(5, '0')}`,
    title: `${WORDS[i % WORDS.length]} ${WORDS[(i * 3) % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} item ${i}`,
    category: CATEGORIES[i % CATEGORIES.length],
    price: i % 97,
  }))
}

const indexConfig = {
  schema: { title: 'string' as const, category: 'enum' as const, price: 'number' as const },
  language: 'english',
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function scaledOut(narsil: Narsil, indexName: string): Promise<boolean> {
  const stats = await narsil.getMemoryStats()
  return stats.workerCopies.some(copy => copy.indexName === indexName && copy.scaledOut)
}

async function engineWith(
  config: NarsilConfig | undefined,
  documents: Array<Record<string, unknown>>,
): Promise<Narsil> {
  const narsil = await createNarsil(config)
  await narsil.createIndex('catalogue', { ...indexConfig, partitions: { maxPartitions: 3 } })
  await narsil.insertBatch('catalogue', documents)
  return narsil
}

const QUERIES: QueryParams[] = [
  { term: 'alpha', limit: 25 },
  { term: 'gamma theta', limit: 40, facets: { category: {} } },
  { term: 'beta', filters: { fields: { price: { lt: 30 } } }, limit: 50 },
  { term: 'delta epsilon', limit: 10, offset: 5 },
  { term: 'zeta', termMatch: 'all', limit: 100 },
]

function comparable(result: QueryResult): unknown {
  return {
    count: result.count,
    hits: result.hits.map(hit => ({ id: hit.id, score: hit.score })),
    facets: result.facets,
  }
}

describe.skipIf(!built)('worker copies without any configuration', () => {
  it('holds none while an index stays below 1,000 documents', async () => {
    const narsil = await engineWith(undefined, corpus(COPY_THRESHOLD - 1))
    try {
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(await scaledOut(narsil, 'catalogue')).toBe(false)
      expect((await narsil.getMemoryStats()).workers).toEqual([])
    } finally {
      await narsil.shutdown()
    }
  }, 60_000)

  it('loads a copy onto every worker once an index reaches 1,000 documents', async () => {
    const narsil = await createNarsil()
    const promotions: NarsilEventMap['workerPromote'][] = []
    narsil.on('workerPromote', payload => promotions.push(payload))
    try {
      await narsil.createIndex('catalogue', indexConfig)
      await narsil.insertBatch('catalogue', corpus(COPY_THRESHOLD))
      await waitFor(() => scaledOut(narsil, 'catalogue'))

      const stats = await narsil.getMemoryStats()
      expect(stats.workers.length).toBeGreaterThan(0)
      expect(stats.workerCopies).toEqual([{ indexName: 'catalogue', scaledOut: true, reloadCount: 0 }])
      expect(promotions).toHaveLength(1)
      expect(promotions[0].reason).toContain('1000')
      expect(promotions[0].workerCount).toBe(stats.workers.length)
    } finally {
      await narsil.shutdown()
    }
  }, 60_000)

  it('leaves both pools absent when workers are switched off', async () => {
    const narsil = await engineWith({ workers: { enabled: false } }, corpus(COPY_THRESHOLD + 200))
    try {
      await new Promise(resolve => setTimeout(resolve, 200))
      const stats = await narsil.getMemoryStats()
      expect(stats.workers).toEqual([])
      expect(stats.workerCopies).toEqual([{ indexName: 'catalogue', scaledOut: false, reloadCount: 0 }])
    } finally {
      await narsil.shutdown()
    }
  }, 60_000)

  it('lets a caller move the copy threshold', async () => {
    const narsil = await engineWith({ workers: { promotionThreshold: 50 } }, corpus(60))
    try {
      await waitFor(() => scaledOut(narsil, 'catalogue'))
      expect((await narsil.getMemoryStats()).workers.length).toBeGreaterThan(0)
    } finally {
      await narsil.shutdown()
    }
  }, 60_000)

  it('splits the thread budget between the keyword copies and the vector pool', async () => {
    const narsil = await engineWith({ workers: { count: 5 } }, corpus(COPY_THRESHOLD))
    try {
      await waitFor(() => scaledOut(narsil, 'catalogue'))
      expect((await narsil.getMemoryStats()).workers).toHaveLength(3)
    } finally {
      await narsil.shutdown()
    }
  }, 60_000)
})

describe.skipIf(!built)('a query answers the same with copies on and off', () => {
  it('returns identical hits, scores, counts, and facets, alone and under concurrent load', async () => {
    const documents = corpus(COPY_THRESHOLD + 500)
    const alone = await engineWith({ workers: { enabled: false } }, documents)
    const copied = await engineWith({ workers: { count: 4 } }, documents)
    try {
      await waitFor(() => scaledOut(copied, 'catalogue'))

      for (const params of QUERIES) {
        const expected = comparable(await alone.query('catalogue', params))
        expect(comparable(await copied.query('catalogue', params))).toEqual(expected)
      }

      const concurrent = await Promise.all(
        Array.from({ length: 32 }, (_, i) => copied.query('catalogue', QUERIES[i % QUERIES.length])),
      )
      for (let i = 0; i < concurrent.length; i++) {
        const expected = comparable(await alone.query('catalogue', QUERIES[i % QUERIES.length]))
        expect(comparable(concurrent[i])).toEqual(expected)
      }
    } finally {
      await alone.shutdown()
      await copied.shutdown()
    }
  }, 120_000)
})

describe.skipIf(!built)('an idle index gives up its copies and takes them back on the next request', () => {
  it('drops the copies after the idle timeout, answers the next query from the main copy, and reloads them', async () => {
    const narsil = await engineWith({ workers: { count: 2, idleTimeoutMs: 400 } }, corpus(COPY_THRESHOLD))
    try {
      await waitFor(() => scaledOut(narsil, 'catalogue'))
      await waitFor(async () => !(await scaledOut(narsil, 'catalogue')), 10_000)
      expect((await narsil.getMemoryStats()).workers.length).toBeGreaterThan(0)

      const answered = await narsil.query('catalogue', { term: 'alpha', limit: 5 })
      expect(answered.hits).toHaveLength(5)

      await waitFor(() => scaledOut(narsil, 'catalogue'), 10_000)
      const stats = await narsil.getMemoryStats()
      expect(stats.workerCopies).toEqual([{ indexName: 'catalogue', scaledOut: true, reloadCount: 1 }])

      await narsil.insert('catalogue', { id: 'late-arrival', title: 'omega late arrival', category: 'film', price: 1 })
      await new Promise(resolve => setTimeout(resolve, 100))
      const fresh = await narsil.query('catalogue', { term: 'omega', limit: 5 })
      expect(fresh.hits.map(hit => hit.id)).toEqual(['late-arrival'])
    } finally {
      await narsil.shutdown()
    }
  }, 60_000)
})
