import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import type { IndexConfig } from '../../types/schema'

const MOVIE_SCHEMA: IndexConfig = {
  schema: { title: 'string', year: 'number', genre: 'enum' },
  language: 'english',
}

describe('durability recovery (in-process)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-recovery-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('recovers documents written before a clean shutdown', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('movies', MOVIE_SCHEMA)
    await writer.insert('movies', { title: 'Dune', year: 2021, genre: 'scifi' }, 'm1')
    await writer.insert('movies', { title: 'Arrival', year: 2016, genre: 'scifi' }, 'm2')
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.get('movies', 'm1')).toMatchObject({ title: 'Dune', year: 2021 })
    expect(await reader.get('movies', 'm2')).toMatchObject({ title: 'Arrival', year: 2016 })
    expect(await reader.countDocuments('movies')).toBe(2)
    await reader.shutdown()
  })

  it('replays updates and removes in order', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('movies', MOVIE_SCHEMA)
    await writer.insert('movies', { title: 'Dune', year: 2021, genre: 'scifi' }, 'm1')
    await writer.update('movies', 'm1', { title: 'Dune: Part Two', year: 2024, genre: 'scifi' })
    await writer.insert('movies', { title: 'Tenet', year: 2020, genre: 'scifi' }, 'm2')
    await writer.remove('movies', 'm2')
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.get('movies', 'm1')).toMatchObject({ title: 'Dune: Part Two', year: 2024 })
    expect(await reader.has('movies', 'm2')).toBe(false)
    expect(await reader.countDocuments('movies')).toBe(1)
    await reader.shutdown()
  })

  it('recovers from a checkpoint plus the WAL records after it', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('movies', MOVIE_SCHEMA)
    await writer.insert('movies', { title: 'Dune', year: 2021, genre: 'scifi' }, 'm1')
    await writer.checkpoint('movies')
    await writer.insert('movies', { title: 'Arrival', year: 2016, genre: 'scifi' }, 'm2')
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('movies')).toBe(2)
    expect(await reader.get('movies', 'm1')).toMatchObject({ title: 'Dune' })
    expect(await reader.get('movies', 'm2')).toMatchObject({ title: 'Arrival' })
    await reader.shutdown()
  })

  it('keeps search working after recovery', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('movies', MOVIE_SCHEMA)
    await writer.insert('movies', { title: 'The Matrix Reloaded', year: 2003, genre: 'scifi' }, 'm1')
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    const result = await reader.query('movies', { term: 'matrix' })
    expect(result.hits.length).toBe(1)
    expect(result.hits[0].id).toBe('m1')
    await reader.shutdown()
  })

  it('recovers a batch insert', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('movies', MOVIE_SCHEMA)
    const batch = await writer.insertBatch('movies', [
      { title: 'A', year: 2001, genre: 'drama' },
      { title: 'B', year: 2002, genre: 'drama' },
      { title: 'C', year: 2003, genre: 'drama' },
    ])
    expect(batch.succeeded.length).toBe(3)
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    expect(await reader.countDocuments('movies')).toBe(3)
    await reader.shutdown()
  })

  it('throws CONFIG_INVALID when durability has no directory and the adapter exposes none', async () => {
    await expect(createNarsil({ durability: {} })).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })
})
