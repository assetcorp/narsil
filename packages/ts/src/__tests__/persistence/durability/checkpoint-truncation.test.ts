import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import type { IndexConfig } from '../../../types/schema'

const SCHEMA: IndexConfig = {
  schema: { title: 'string', year: 'number' },
  language: 'english',
}

describe('checkpoint and truncation', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-checkpoint-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('removes WAL segments fully covered by a durable checkpoint', async () => {
    const narsil = await createNarsil({ durability: { directory: root, segmentMaxBytes: 64 } })
    await narsil.createIndex('movies', SCHEMA)

    for (let i = 0; i < 20; i += 1) {
      await narsil.insert('movies', { title: `Movie ${i}`, year: 2000 + i }, `m${i}`)
    }

    const directory = createDurableDirectory(root)
    const segmentsBefore = await directory.list('movies/wal/0/')
    expect(segmentsBefore.length).toBeGreaterThan(1)

    await narsil.checkpoint('movies')

    const segmentsAfter = await directory.list('movies/wal/0/')
    expect(segmentsAfter.length).toBeLessThan(segmentsBefore.length)

    await narsil.shutdown()
  })

  it('recovers the full document set after a checkpoint truncates old segments', async () => {
    const narsil = await createNarsil({ durability: { directory: root, segmentMaxBytes: 64 } })
    await narsil.createIndex('movies', SCHEMA)
    for (let i = 0; i < 20; i += 1) {
      await narsil.insert('movies', { title: `Movie ${i}`, year: 2000 + i }, `m${i}`)
    }
    await narsil.checkpoint('movies')
    for (let i = 20; i < 25; i += 1) {
      await narsil.insert('movies', { title: `Movie ${i}`, year: 2000 + i }, `m${i}`)
    }
    await narsil.shutdown()

    const reader = await createNarsil({ durability: { directory: root, segmentMaxBytes: 64 } })
    expect(await reader.countDocuments('movies')).toBe(25)
    expect(await reader.get('movies', 'm0')).toMatchObject({ title: 'Movie 0' })
    expect(await reader.get('movies', 'm24')).toMatchObject({ title: 'Movie 24' })
    await reader.shutdown()
  })

  it('writes a snapshot that survives a crash before truncation', async () => {
    const narsil = await createNarsil({ durability: { directory: root } })
    await narsil.createIndex('movies', SCHEMA)
    await narsil.insert('movies', { title: 'Dune', year: 2021 }, 'm1')
    await narsil.checkpoint('movies')
    await narsil.shutdown()

    const directory = createDurableDirectory(root)
    const snapshot = await directory.read('movies/snapshot')
    expect(snapshot).not.toBeNull()
  })
})
