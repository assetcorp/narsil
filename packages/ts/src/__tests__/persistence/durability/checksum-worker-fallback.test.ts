import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { __failNextChecksumWorkerForTests, resetChecksumWorkerLatch } from '../../../serialization/checksum-dispatch'
import type { IndexConfig } from '../../../types/schema'

const SCHEMA: IndexConfig = {
  schema: { title: 'string', year: 'number' },
  language: 'english',
}

describe('checksum worker failure recovery', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-checksum-fallback-'))
  })

  afterEach(async () => {
    resetChecksumWorkerLatch()
    await rm(root, { recursive: true, force: true })
  })

  it('completes a checkpoint and stays durable when the checksum worker fails', async () => {
    const narsil = await createNarsil({ durability: { directory: root, segmentMaxBytes: 64 } })
    await narsil.createIndex('movies', SCHEMA)
    for (let i = 0; i < 20; i += 1) {
      await narsil.insert('movies', { title: `Movie ${i}`, year: 2000 + i }, `m${i}`)
    }

    __failNextChecksumWorkerForTests()
    await expect(narsil.checkpoint('movies')).resolves.toBeUndefined()

    for (let i = 20; i < 25; i += 1) {
      await narsil.insert('movies', { title: `Movie ${i}`, year: 2000 + i }, `m${i}`)
    }
    await narsil.shutdown()

    const reader = await createNarsil({ durability: { directory: root, segmentMaxBytes: 64 } })
    expect(await reader.countDocuments('movies')).toBe(25)
    expect(await reader.get('movies', 'm0')).toMatchObject({ title: 'Movie 0' })
    expect(await reader.get('movies', 'm24')).toMatchObject({ title: 'Movie 24' })
    await reader.shutdown()
  }, 30_000)
})
