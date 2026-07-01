import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import { createFilesystemPersistence } from '../../persistence/filesystem'
import { createMemoryPersistence } from '../../persistence/memory'
import type { PersistenceAdapter } from '../../types/adapters'
import type { IndexConfig } from '../../types/schema'

const SCHEMA: IndexConfig = {
  schema: { title: 'string', year: 'number' },
  language: 'english',
}

describe('durability tiers', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-tiers-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('routes a filesystem persistence adapter into the WAL tier and recovers every write', async () => {
    const writer = await createNarsil({ persistence: createFilesystemPersistence({ directory: root }) })
    await writer.createIndex('movies', SCHEMA)
    for (let i = 0; i < 6; i += 1) {
      await writer.insert('movies', { title: `Movie ${i}`, year: 2000 + i }, `m${i}`)
    }
    await writer.shutdown()

    const reader = await createNarsil({ persistence: createFilesystemPersistence({ directory: root }) })
    try {
      expect(await reader.countDocuments('movies')).toBe(6)
      expect(await reader.get('movies', 'm5')).toMatchObject({ title: 'Movie 5' })
    } finally {
      await reader.shutdown()
    }
  })

  it('persists snapshot-only for a non-filesystem adapter and loses writes made after the last snapshot', async () => {
    const store = new Map<string, Uint8Array>()
    const adapter: PersistenceAdapter = {
      async save(key, data) {
        store.set(key, new Uint8Array(data))
      },
      async load(key) {
        const value = store.get(key)
        return value === undefined ? null : new Uint8Array(value)
      },
      async delete(key) {
        store.delete(key)
      },
      async list(prefix) {
        return [...store.keys()].filter(k => k.startsWith(prefix))
      },
    }

    const writer = await createNarsil({ persistence: adapter })
    await writer.createIndex('movies', SCHEMA)
    for (let i = 0; i < 4; i += 1) {
      await writer.insert('movies', { title: `Movie ${i}`, year: 2000 + i }, `m${i}`)
    }
    await writer.checkpoint('movies')
    await writer.insert('movies', { title: 'Lost', year: 2099 }, 'lost-1')
    await writer.insert('movies', { title: 'Lost', year: 2099 }, 'lost-2')

    const reader = await createNarsil({ persistence: adapter })
    try {
      expect(await reader.countDocuments('movies')).toBe(4)
      expect(await reader.has('movies', 'lost-1')).toBe(false)
      expect(await reader.has('movies', 'lost-2')).toBe(false)
    } finally {
      await reader.shutdown()
    }
    await writer.shutdown()
  })

  it('rejects WAL durability requested for a non-filesystem backend with CONFIG_INVALID', async () => {
    await expect(
      createNarsil({ persistence: createMemoryPersistence(), durability: { mode: 'sync' } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })
})
