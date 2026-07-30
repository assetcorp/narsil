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

  it('forces the snapshot tier onto a filesystem adapter when durability.tier is snapshot', async () => {
    const adapter = createFilesystemPersistence({ directory: root })
    const writer = await createNarsil({ persistence: adapter, durability: { tier: 'snapshot' } })
    await writer.createIndex('movies', SCHEMA)
    for (let i = 0; i < 4; i += 1) {
      await writer.insert('movies', { title: `Movie ${i}`, year: 2000 + i }, `m${i}`)
    }
    await writer.checkpoint('movies')
    await writer.insert('movies', { title: 'Lost', year: 2099 }, 'lost-1')

    const keys = await adapter.list('movies/')
    expect(keys).toContain('movies/snapshot')
    expect(keys.some(k => k.startsWith('movies/wal/'))).toBe(false)

    const reader = await createNarsil({
      persistence: createFilesystemPersistence({ directory: root }),
      durability: { tier: 'snapshot' },
    })
    try {
      expect(await reader.countDocuments('movies')).toBe(4)
      expect(await reader.has('movies', 'lost-1')).toBe(false)
    } finally {
      await reader.shutdown()
    }
    await writer.shutdown()
  })

  it('rejects the snapshot tier without a persistence adapter', async () => {
    await expect(createNarsil({ durability: { tier: 'snapshot' } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    })
  })

  it('rejects an explicit WAL tier when no directory can be resolved', async () => {
    await expect(
      createNarsil({ persistence: createMemoryPersistence(), durability: { tier: 'wal' } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await expect(createNarsil({ durability: { tier: 'wal' } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    })
  })

  it('rejects an unknown tier value', async () => {
    await expect(
      createNarsil({
        persistence: createFilesystemPersistence({ directory: root }),
        durability: { tier: 'snapshots' as 'snapshot' },
      }),
    ).rejects.toThrow(/durability\.tier must be "wal" or "snapshot"/)
  })

  it('rejects an unknown mode value', async () => {
    await expect(
      createNarsil({
        persistence: createFilesystemPersistence({ directory: root }),
        durability: { mode: 'eventually' as 'sync' },
      }),
    ).rejects.toThrow(/durability\.mode must be "sync" or "async"/)
  })

  it('rejects non-finite and out-of-range numeric knobs', async () => {
    const fsPersistence = () => createFilesystemPersistence({ directory: root })
    await expect(
      createNarsil({ persistence: fsPersistence(), durability: { checkpointIntervalMs: Number.NaN } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await expect(
      createNarsil({ persistence: fsPersistence(), durability: { checkpointIntervalMs: -1 } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await expect(
      createNarsil({ persistence: fsPersistence(), durability: { checkpointMutationThreshold: 0 } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await expect(
      createNarsil({ persistence: fsPersistence(), durability: { segmentMaxBytes: Infinity } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await expect(
      createNarsil({ persistence: fsPersistence(), durability: { compactionThreshold: 0 } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('keeps a zero checkpoint interval legal as the timer-off value', async () => {
    const narsil = await createNarsil({
      persistence: createFilesystemPersistence({ directory: root }),
      durability: { checkpointIntervalMs: 0 },
    })
    await narsil.shutdown()
  })

  it('rejects write-ahead log fields combined with the snapshot tier', async () => {
    const fsPersistence = () => createFilesystemPersistence({ directory: root })
    await expect(
      createNarsil({ persistence: fsPersistence(), durability: { tier: 'snapshot', mode: 'sync' } }),
    ).rejects.toThrow(/durability\.mode applies to the write-ahead log tier only/)
    await expect(
      createNarsil({ persistence: fsPersistence(), durability: { tier: 'snapshot', directory: root } }),
    ).rejects.toThrow(/durability\.directory applies to the write-ahead log tier only/)
    await expect(
      createNarsil({ persistence: fsPersistence(), durability: { tier: 'snapshot', segmentMaxBytes: 1024 } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('accepts checkpoint knobs alongside the snapshot tier', async () => {
    const narsil = await createNarsil({
      persistence: createFilesystemPersistence({ directory: root }),
      durability: { tier: 'snapshot', checkpointIntervalMs: 60_000, checkpointMutationThreshold: 500 },
    })
    await narsil.shutdown()
  })

  it('runs the WAL tier under an explicit wal override with a filesystem adapter', async () => {
    const writer = await createNarsil({
      persistence: createFilesystemPersistence({ directory: root }),
      durability: { tier: 'wal' },
    })
    await writer.createIndex('movies', SCHEMA)
    await writer.insert('movies', { title: 'Durable without checkpoint', year: 2026 }, 'm-wal')
    await writer.shutdown()

    const reader = await createNarsil({ persistence: createFilesystemPersistence({ directory: root }) })
    try {
      expect(await reader.has('movies', 'm-wal')).toBe(true)
    } finally {
      await reader.shutdown()
    }
  })
})
