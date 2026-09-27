import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexConfig } from '../../types/schema'

const MOVIE_SCHEMA: IndexConfig = {
  schema: { title: 'string', year: 'number' },
  language: 'english',
}

describe('a durability directory removed while the engine writes to it', { timeout: 30_000 }, () => {
  let root: string
  let engine: Narsil
  const reported: Error[] = []

  beforeEach(async () => {
    reported.length = 0
    root = await mkdtemp(join(tmpdir(), 'narsil-directory-loss-'))
    engine = await createNarsil({
      durability: { directory: root, tier: 'wal', mode: 'sync' },
      workers: { enabled: false },
    })
    engine.on('durabilityError', ({ error }) => reported.push(error))
    await engine.createIndex('movies', MOVIE_SCHEMA)
    await engine.insertBatch(
      'movies',
      Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, title: `Film ${i}`, year: 2000 + i })),
    )
  })

  afterEach(async () => {
    await engine.shutdown().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })

  it('fails the next checkpoint, reports the loss, and refuses every later write', async () => {
    await rm(root, { recursive: true, force: true })

    await expect(engine.checkpoint('movies')).rejects.toMatchObject({ code: 'PERSISTENCE_SAVE_FAILED' })
    expect(reported).toHaveLength(1)
    expect(reported[0].message).toContain('is missing or is a different directory')

    await expect(engine.insert('movies', { title: 'Too late', year: 2050 }, 'late')).rejects.toMatchObject({
      code: 'PERSISTENCE_SAVE_FAILED',
    })
  })

  it('notices the loss within a few seconds with no checkpoint to reveal it', async () => {
    await rm(root, { recursive: true, force: true })

    await vi.waitFor(() => expect(reported).toHaveLength(1), { timeout: 5_000, interval: 100 })
    await expect(engine.insert('movies', { title: 'Too late', year: 2050 }, 'late')).rejects.toMatchObject({
      code: 'PERSISTENCE_SAVE_FAILED',
    })
  })

  it('refuses the first synchronous write after the loss, before any timer or checkpoint notices it', async () => {
    await rm(root, { recursive: true, force: true })

    await expect(engine.insert('movies', { title: 'Too late', year: 2050 }, 'late')).rejects.toMatchObject({
      code: 'PERSISTENCE_SAVE_FAILED',
    })
    const batch = await engine.insertBatch('movies', [{ id: 'later', title: 'Later', year: 2051 }])
    expect(batch.succeeded).toEqual([])
    expect(reported).toHaveLength(1)
  })

  it('reports a checkpoint into a read-only index folder as a durability failure', async () => {
    const indexFolder = join(root, 'movies')
    await chmod(indexFolder, 0o500)
    try {
      await expect(engine.checkpoint('movies')).rejects.toMatchObject({ code: 'PERSISTENCE_SAVE_FAILED' })
      expect(reported).toHaveLength(1)
      expect(reported[0]).toMatchObject({ code: 'PERSISTENCE_SAVE_FAILED' })
    } finally {
      await chmod(indexFolder, 0o700)
    }
  })

  it('keeps writing where the directory stays in place', async () => {
    await engine.checkpoint('movies')
    await engine.insert('movies', { title: 'Still here', year: 2051 }, 'kept')
    expect(reported).toHaveLength(0)
  })
})
