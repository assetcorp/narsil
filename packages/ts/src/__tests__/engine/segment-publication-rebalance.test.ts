import { describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'

function barrier(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}

describe('segment publication during partition replacement', () => {
  it.each(['buffered', 'completed'] as const)(
    'retains every acknowledged document when a rebalance is %s between segment chunks',
    { timeout: 60_000 },
    async mode => {
      const split = barrier()
      const resume = barrier()
      let armed = false
      let started = false
      let publishedBeforeRebalance = 0
      let rebalance: Promise<void> | undefined
      const engine = await createNarsil({
        workers: { enabled: true, count: 2, promotionThreshold: 1 },
        plugins: [
          {
            name: 'rebalance-between-insert-publications',
            async afterInsert() {
              if (!armed || started) return
              started = true
              publishedBeforeRebalance = await engine.countDocuments('records')
              rebalance = engine.rebalance('records', 3)
              if (mode === 'completed') await rebalance
              else await split.promise
            },
            async onPartitionSplit() {
              if (!armed || mode !== 'buffered') return
              split.release()
              await resume.promise
            },
          },
        ],
      })
      try {
        await engine.createIndex('records', {
          schema: { title: 'string', embedding: 'vector[2]' },
          partitions: { maxPartitions: 4 },
        })
        await engine.insert('records', { id: 'seed', title: 'seed', embedding: [1, 0] }, undefined, { wait: true })
        await expect
          .poll(async () => (await engine.getMemoryStats()).workerCopies.some(copy => copy.scaledOut))
          .toBe(true)
        const documents = Array.from({ length: 4_800 }, (_, position) => ({
          id: `record-${position}`,
          title: 'published record',
          embedding: position % 2 === 0 ? [1, 0] : [0, 1],
        }))
        armed = true
        const inserted = await engine.insertBatch('records', documents)
        expect(started).toBe(true)
        expect(publishedBeforeRebalance).toBeGreaterThan(1_001)
        expect(publishedBeforeRebalance).toBeLessThan(documents.length)
        expect(inserted.failed).toEqual([])
        expect(inserted.succeeded).toHaveLength(documents.length)
        resume.release()
        await rebalance
        expect(await engine.countDocuments('records')).toBe(documents.length + 1)
        const found = await engine.query<{ embedding: Float32Array }>('records', {
          term: 'published',
          limit: 5_000,
        })
        expect(found.count).toBe(documents.length)
        expect(new Set(found.hits.map(hit => hit.id))).toEqual(new Set(documents.map(doc => doc.id)))
        const expected = new Map(documents.map(doc => [doc.id, doc.embedding]))
        for (const hit of found.hits) expect(Array.from(hit.document?.embedding ?? [])).toEqual(expected.get(hit.id))
        const ranked = await engine.query<{ embedding: Float32Array }>('records', {
          vector: { field: 'embedding', value: [1, 0] },
          limit: 5_000,
        })
        expect(ranked.hits).toHaveLength(documents.length + 1)
        for (const hit of ranked.hits) {
          const vector = hit.document?.embedding
          expect(vector).toBeDefined()
          if (vector === undefined) throw new Error('A vector hit has no document vector')
          expect(hit.score).toBeCloseTo(vector[0] / Math.hypot(...vector), 6)
        }
      } finally {
        resume.release()
        await rebalance?.catch(() => undefined)
        await engine.shutdown()
      }
    },
  )
})
