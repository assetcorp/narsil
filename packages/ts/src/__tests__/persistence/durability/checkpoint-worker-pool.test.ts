import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import {
  __checkpointWorkerIsPooledForTests,
  __checkpointWorkerSpawnCountForTests,
  __failNextCheckpointWorkerForTests,
  __setCheckpointWorkerIdleMsForTests,
  resetCheckpointWorkerLatch,
} from '../../../persistence/durability/checkpoint-worker-dispatch'
import type { IndexConfig } from '../../../types/schema'

const SCHEMA: IndexConfig = {
  schema: { title: 'string', body: 'string', year: 'number' },
  language: 'english',
}

function doc(i: number): { title: string; body: string; year: number } {
  return {
    title: `Document ${i}`,
    body: `the quick brown fox number ${i} jumps over the lazy dog`,
    year: 2000 + (i % 30),
  }
}

describe('pooled checkpoint worker', () => {
  let root: string

  beforeEach(async () => {
    resetCheckpointWorkerLatch()
    root = await mkdtemp(join(tmpdir(), 'narsil-ckpt-pool-'))
  })

  afterEach(async () => {
    resetCheckpointWorkerLatch()
    await rm(root, { recursive: true, force: true })
  })

  it('reuses a single worker thread across many checkpoints', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)

    for (let round = 0; round < 4; round += 1) {
      const base = round * 10
      for (let i = base; i < base + 10; i += 1) {
        await writer.insert('docs', doc(i), `d${i}`)
      }
      await writer.checkpoint('docs')
    }

    expect(__checkpointWorkerSpawnCountForTests()).toBe(1)

    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(40)
    await reader.shutdown()
  })

  it('ends the worker thread once it sits idle, so that the memory of a finished checkpoint goes back', async () => {
    __setCheckpointWorkerIdleMsForTests(400)
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 10; i += 1) await writer.insert('docs', doc(i), `d${i}`)
    await writer.checkpoint('docs')
    expect(__checkpointWorkerIsPooledForTests()).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 900))
    expect(__checkpointWorkerIsPooledForTests()).toBe(false)

    for (let i = 10; i < 20; i += 1) await writer.insert('docs', doc(i), `d${i}`)
    await writer.checkpoint('docs')
    expect(__checkpointWorkerSpawnCountForTests()).toBe(2)
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(20)
    await reader.shutdown()
  })

  it('falls back inline when the worker is forced to fail and recovers on the next checkpoint', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 10; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }

    __failNextCheckpointWorkerForTests()
    await writer.checkpoint('docs')

    for (let i = 10; i < 20; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')

    expect(__checkpointWorkerSpawnCountForTests()).toBe(1)

    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('docs')).toBe(20)
    expect(await reader.get('docs', 'd19')).toMatchObject({ title: 'Document 19' })
    await reader.shutdown()
  })

  it('terminates the pooled worker on shutdown so no thread persists', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 10; i += 1) {
      await writer.insert('docs', doc(i), `d${i}`)
    }
    await writer.checkpoint('docs')
    expect(__checkpointWorkerSpawnCountForTests()).toBe(1)
    await writer.shutdown()

    resetCheckpointWorkerLatch()
    expect(__checkpointWorkerSpawnCountForTests()).toBe(0)
  })
})
