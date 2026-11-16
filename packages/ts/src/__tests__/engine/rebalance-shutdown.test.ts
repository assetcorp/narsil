import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import type { BatchResult } from '../../types/results'

it('recovers acknowledged queued inserts when a rebalance hook awaits shutdown at the queue limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-batch-shutdown-'))
  const ids = Array.from({ length: 10_001 }, (_, position) => `queued-${position}`)
  let result: BatchResult | undefined
  const writer = await createNarsil({
    workers: { enabled: false },
    durability: { directory, mode: 'sync' },
    plugins: [
      {
        name: 'shutdown-after-queued-inserts',
        async onPartitionSplit() {
          result = await writer.insertBatch(
            'notes',
            ids.map(id => ({ id, title: 'harbour' })),
          )
          await writer.shutdown()
        },
      },
    ],
  })
  try {
    await writer.createIndex('notes', { schema: { title: 'string' }, partitions: { maxPartitions: 2 } })
    await writer.insert('notes', { title: 'original' }, 'original')
    await writer.rebalance('notes', 1).catch(() => undefined)
    await writer.shutdown()
    expect(result?.succeeded).toEqual(ids.slice(0, 10_000))
    expect(result?.failed.map(failure => [failure.docId, failure.error.code])).toEqual([
      ['queued-10000', 'PARTITION_REBALANCING_BACKPRESSURE'],
    ])

    const reader = await createNarsil({ workers: { enabled: false }, durability: { directory, mode: 'sync' } })
    try {
      expect((await reader.query('notes', { term: 'harbour', limit: 10_000 })).hits.map(hit => hit.id).sort()).toEqual(
        ids.slice(0, 10_000).sort(),
      )
      expect(await reader.get('notes', 'queued-10000')).toBeUndefined()
      expect(await reader.get('notes', 'original')).toEqual({ title: 'original' })
    } finally {
      await reader.shutdown()
    }
  } finally {
    await writer.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
