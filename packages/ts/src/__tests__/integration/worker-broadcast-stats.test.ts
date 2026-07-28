import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNarsil } from '../../narsil'
import { createMemoryPersistence } from '../../persistence/memory'
import type { InvalidationAdapter, InvalidationEvent } from '../../types/adapters'

const distEntry = new URL('../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

function createCapturingInvalidation(): InvalidationAdapter & {
  emit(event: InvalidationEvent): void
} {
  let handler: ((event: InvalidationEvent) => void) | null = null
  return {
    async publish(_event: InvalidationEvent): Promise<void> {},
    async subscribe(fn: (event: InvalidationEvent) => void): Promise<void> {
      handler = fn
    },
    async shutdown(): Promise<void> {
      handler = null
    },
    emit(event: InvalidationEvent): void {
      handler?.(event)
    },
  }
}

describe.skipIf(!built)('a promoted index scores broadcast queries with merged statistics over the wire', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reflects foreign instance statistics in scores computed inside the worker', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    const invalidation = createCapturingInvalidation()
    const narsil = await createNarsil({
      persistence: createMemoryPersistence(),
      invalidation,
      workers: { enabled: true, count: 1, promotionThreshold: 2 },
    })

    await narsil.createIndex('prose', {
      schema: { title: 'string' },
      language: 'english',
      defaultScoring: 'broadcast',
    })

    const promoted = new Promise<number>(resolve => {
      narsil.on('workerPromote', payload => resolve(payload.workerCount))
    })
    const failed = new Promise<Error>(resolve => {
      narsil.on('workerPromoteFailure', payload => resolve(payload.error))
    })

    await narsil.insert('prose', { title: 'the rise of the machine' })
    await narsil.insert('prose', { title: 'the fall of the empire' })
    await narsil.insert('prose', { title: 'a quiet afternoon' })

    expect(await Promise.race([promoted, failed])).toBe(1)

    const baseline = await narsil.query('prose', { term: 'machine', includeScoreComponents: true })
    expect(baseline.hits.length).toBe(1)
    const baselineComponents = baseline.hits[0].scoreComponents
    expect(baselineComponents).toBeDefined()
    const token = Object.keys(baselineComponents?.idf ?? {})[0]
    const baselineIdf = baselineComponents?.idf[token] ?? 0
    expect(baselineIdf).toBeGreaterThan(0)

    invalidation.emit({
      type: 'statistics',
      indexName: 'prose',
      instanceId: 'foreign-instance',
      stats: {
        totalDocs: 50_000,
        docFrequencies: { [token]: 2 },
        totalFieldLengths: { title: 250_000 },
      },
    })

    const merged = await narsil.query('prose', { term: 'machine', includeScoreComponents: true })
    expect(merged.hits.length).toBe(1)
    const mergedIdf = merged.hits[0].scoreComponents?.idf[token] ?? 0
    expect(mergedIdf).toBeGreaterThan(baselineIdf)

    const workerFallbacks = warnSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('Worker search failed'),
    )
    expect(workerFallbacks).toEqual([])

    await narsil.shutdown()
  }, 30_000)
})
