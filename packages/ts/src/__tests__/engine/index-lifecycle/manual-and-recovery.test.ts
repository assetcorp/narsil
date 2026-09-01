import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil } from '../../../narsil'
import { createMemoryPersistence } from '../../../persistence/memory'
import { readMetadataEnvelope, writeMetadataEnvelope } from '../../../serialization/envelope'
import type { PersistenceAdapter } from '../../../types/adapters'
import type { Narsil } from '../../../types/engine'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let settle = (): void => undefined
  const promise = new Promise<void>(resolve => {
    settle = resolve
  })
  return { promise, resolve: () => settle() }
}

describe('index lifecycle', () => {
  let directory = ''
  let engine: Narsil | null = null

  afterEach(async () => {
    vi.restoreAllMocks()
    await engine?.shutdown()
    engine = null
    if (directory.length > 0) {
      await rm(directory, { recursive: true, force: true })
      directory = ''
    }
  })

  async function waitForClosed(indexName: string): Promise<void> {
    const deadline = Date.now() + 2_000
    while (engine?.listIndexes().find(index => index.name === indexName)?.state !== 'closed') {
      if (Date.now() >= deadline) throw new Error(`Index "${indexName}" did not close before the deadline`)
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    }
  }

  it('closes and reopens an index without deleting its documents', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-index-lifecycle-'))
    engine = await createNarsil({ durability: { directory }, lifecycle: {} })
    await engine.createIndex('products', { schema: { title: 'string' } })
    await engine.insert('products', { title: 'Desk lamp' }, 'lamp')

    await engine.close('products')

    expect(engine.listIndexes()).toEqual([
      expect.objectContaining({ name: 'products', documentCount: 1, state: 'closed', reopenCount: 0 }),
    ])
    expect((await engine.getMemoryStats()).openIndexCount).toBe(0)
    expect(await engine.get('products', 'lamp')).toEqual({ title: 'Desk lamp' })
    expect(engine.listIndexes()[0]).toEqual(expect.objectContaining({ state: 'open', reopenCount: 1 }))
  })

  it('registers persisted indexes as closed until a request needs one', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-index-lifecycle-'))
    engine = await createNarsil({ durability: { directory }, lifecycle: {} })
    await engine.createIndex('products', { schema: { title: 'string' } })
    await engine.insert('products', { title: 'Desk lamp' }, 'lamp')
    await engine.checkpoint('products')
    await engine.shutdown()

    engine = await createNarsil({ durability: { directory }, lifecycle: {} })

    expect(engine.listIndexes()).toEqual([
      expect.objectContaining({ name: 'products', documentCount: 1, state: 'closed', reopenCount: 0 }),
    ])
    expect(engine.getStats('products')).toEqual(expect.objectContaining({ documentCount: 1 }))
    expect((await engine.getMemoryStats()).estimatedIndexBytes).toBe(0)
    expect(await engine.countDocuments('products')).toBe(1)
    expect(engine.listIndexes()[0]).toEqual(expect.objectContaining({ state: 'open', reopenCount: 1 }))
  })

  it('derives the closed count from the snapshot for metadata written before checkpoint counts', async () => {
    const storage = createMemoryPersistence()
    engine = await createNarsil({ persistence: storage, durability: { tier: 'snapshot' }, lifecycle: {} })
    await engine.createIndex('products', { schema: { title: 'string' } })
    await engine.insert('products', { title: 'Desk lamp' }, 'lamp')
    await engine.insert('products', { title: 'Desk chair' }, 'chair')
    await engine.checkpoint('products')
    await engine.shutdown()
    const metadataBytes = await storage.load('products/meta')
    expect(metadataBytes).not.toBeNull()
    if (metadataBytes === null) return
    const { metadata } = await readMetadataEnvelope(metadataBytes)
    delete metadata.documentCount
    await storage.save('products/meta', await writeMetadataEnvelope(metadata, { checksum: true }))

    engine = await createNarsil({ persistence: storage, durability: { tier: 'snapshot' }, lifecycle: {} })

    expect(engine.listIndexes()).toEqual([expect.objectContaining({ documentCount: 2, state: 'closed' })])
    expect(engine.getStats('products')).toEqual(expect.objectContaining({ documentCount: 2 }))
    const upgradedBytes = await storage.load('products/meta')
    expect(upgradedBytes).not.toBeNull()
    if (upgradedBytes === null) return
    expect((await readMetadataEnvelope(upgradedBytes)).metadata.documentCount).toBe(2)
    expect(await engine.countDocuments('products')).toBe(2)
  })

  it('derives the closed count from segments for metadata written before checkpoint counts', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-index-lifecycle-'))
    engine = await createNarsil({ durability: { directory } })
    await engine.createIndex('products', { schema: { title: 'string' } })
    await engine.insert('products', { title: 'Desk lamp' }, 'lamp')
    await engine.insert('products', { title: 'Desk chair' }, 'chair')
    await engine.checkpoint('products')
    await engine.update('products', 'lamp', { title: 'Angle lamp' })
    await engine.insert('products', { title: 'Side table' }, 'table')
    await engine.remove('products', 'chair')
    await engine.checkpoint('products')
    await engine.shutdown()
    const metadataPath = join(directory, 'products', 'meta')
    const { metadata } = await readMetadataEnvelope(new Uint8Array(await readFile(metadataPath)))
    delete metadata.documentCount
    await writeFile(metadataPath, await writeMetadataEnvelope(metadata, { checksum: true }))

    engine = await createNarsil({ durability: { directory }, lifecycle: {} })

    expect(engine.listIndexes()).toEqual([expect.objectContaining({ documentCount: 2, state: 'closed' })])
    const upgraded = await readMetadataEnvelope(new Uint8Array(await readFile(metadataPath)))
    expect(upgraded.metadata.documentCount).toBe(2)
    expect(await engine.countDocuments('products')).toBe(2)
  })

  it('evicts the least recently used index when the open-index limit is reached', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-index-lifecycle-'))
    engine = await createNarsil({
      durability: { directory },
      lifecycle: { maxOpenIndexes: 1 },
    })
    await engine.createIndex('older', { schema: { title: 'string' } })
    await engine.insert('older', { title: 'Desk lamp' }, 'lamp')
    await engine.createIndex('newer', { schema: { title: 'string' } })

    expect(engine.listIndexes()).toEqual([
      expect.objectContaining({ name: 'older', state: 'closed' }),
      expect.objectContaining({ name: 'newer', state: 'open' }),
    ])
  })

  it('evicts the least recently used index when the open-byte limit is reached', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-index-lifecycle-'))
    engine = await createNarsil({
      durability: { directory },
      lifecycle: { maxOpenBytes: 1 },
    })
    await engine.createIndex('older', { schema: { title: 'string' } })
    await engine.insert('older', { title: 'Desk lamp' }, 'lamp')
    await engine.createIndex('newer', { schema: { title: 'string' } })

    expect(engine.listIndexes()).toEqual([
      expect.objectContaining({ name: 'older', state: 'closed' }),
      expect.objectContaining({ name: 'newer', state: 'open' }),
    ])
  })

  it('closes an index after its idle timeout', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-index-lifecycle-'))
    engine = await createNarsil({
      durability: { directory },
      lifecycle: { idleTimeoutMs: 100 },
    })
    await engine.createIndex('products', { schema: { title: 'string' } })

    await waitForClosed('products')

    expect(engine.listIndexes()[0]).toEqual(expect.objectContaining({ state: 'closed' }))
  })

  it('keeps an index open when its close checkpoint fails', async () => {
    const storage = createMemoryPersistence()
    let rejectSnapshot = false
    const adapter: PersistenceAdapter = {
      save(key, data) {
        if (rejectSnapshot && key.endsWith('/snapshot')) return Promise.reject(new Error('snapshot unavailable'))
        return storage.save(key, data)
      },
      load: key => storage.load(key),
      delete: key => storage.delete(key),
      list: prefix => storage.list(prefix),
    }
    engine = await createNarsil({ persistence: adapter, durability: { tier: 'snapshot' }, lifecycle: {} })
    await engine.createIndex('products', { schema: { title: 'string' } })
    await engine.insert('products', { title: 'Desk lamp' }, 'lamp')
    rejectSnapshot = true

    await expect(engine.close('products')).rejects.toThrow('snapshot unavailable')

    expect(engine.listIndexes()[0]).toEqual(expect.objectContaining({ state: 'open' }))
    expect(await engine.get('products', 'lamp')).toEqual({ title: 'Desk lamp' })
  })

  it('writes a fresh snapshot when close meets an older checkpoint', async () => {
    const storage = createMemoryPersistence()
    const saveStarted = deferred()
    const saveGate = deferred()
    let blockNextSnapshot = false
    const adapter: PersistenceAdapter = {
      async save(key, data) {
        if (blockNextSnapshot && key.endsWith('/snapshot')) {
          blockNextSnapshot = false
          saveStarted.resolve()
          await saveGate.promise
        }
        await storage.save(key, data)
      },
      load: key => storage.load(key),
      delete: key => storage.delete(key),
      list: prefix => storage.list(prefix),
    }
    engine = await createNarsil({ persistence: adapter, durability: { tier: 'snapshot' }, lifecycle: {} })
    await engine.createIndex('products', { schema: { title: 'string' } })
    await engine.insert('products', { title: 'Desk lamp' }, 'lamp')
    blockNextSnapshot = true
    const olderCheckpoint = engine.checkpoint('products')
    await saveStarted.promise
    await engine.insert('products', { title: 'Floor lamp' }, 'floor')
    const close = engine.close('products')
    saveGate.resolve()

    await olderCheckpoint
    await close

    await expect(engine.get('products', 'floor')).resolves.toEqual({ title: 'Floor lamp' })
  })

  it('drains active work before close and reopens for a caller that arrives during close', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-index-lifecycle-'))
    const search = deferred()
    const gate = deferred()
    engine = await createNarsil({
      durability: { directory },
      lifecycle: {},
      plugins: [
        {
          name: 'hold-search',
          async beforeSearch() {
            search.resolve()
            await gate.promise
          },
        },
      ],
    })
    await engine.createIndex('products', { schema: { title: 'string' } })
    await engine.insert('products', { title: 'Desk lamp' }, 'lamp')

    const query = engine.query('products', { term: 'lamp' })
    await search.promise
    let closeSettled = false
    const close = engine.close('products').then(() => {
      closeSettled = true
    })
    const arrival = engine.get('products', 'lamp')
    await Promise.resolve()
    expect(closeSettled).toBe(false)
    gate.resolve()

    await query
    await close
    await expect(arrival).resolves.toEqual({ title: 'Desk lamp' })
    expect(engine.listIndexes()[0]).toEqual(expect.objectContaining({ state: 'open', reopenCount: 1 }))
  })

  it('drains active work before deleting an index', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-index-lifecycle-'))
    const search = deferred()
    const gate = deferred()
    engine = await createNarsil({
      durability: { directory },
      lifecycle: {},
      plugins: [
        {
          name: 'hold-drop-search',
          async beforeSearch() {
            search.resolve()
            await gate.promise
          },
        },
      ],
    })
    await engine.createIndex('products', { schema: { title: 'string' } })
    await engine.insert('products', { title: 'Desk lamp' }, 'lamp')

    const query = engine.query('products', { term: 'lamp' })
    await search.promise
    let dropSettled = false
    const drop = engine.dropIndex('products').then(() => {
      dropSettled = true
    })
    await Promise.resolve()

    expect(dropSettled).toBe(false)
    gate.resolve()
    await expect(query).resolves.toEqual(expect.objectContaining({ count: 1 }))
    await drop
    expect(engine.listIndexes()).toEqual([])
  })

  it('waits for an in-flight checkpoint before deleting durable files', async () => {
    const storage = createMemoryPersistence()
    const saveStarted = deferred()
    const saveGate = deferred()
    let blockNextSnapshot = false
    const adapter: PersistenceAdapter = {
      async save(key, data) {
        if (blockNextSnapshot && key.endsWith('/snapshot')) {
          blockNextSnapshot = false
          saveStarted.resolve()
          await saveGate.promise
        }
        await storage.save(key, data)
      },
      load: key => storage.load(key),
      delete: key => storage.delete(key),
      list: prefix => storage.list(prefix),
    }
    engine = await createNarsil({ persistence: adapter, durability: { tier: 'snapshot' }, lifecycle: {} })
    await engine.createIndex('products', { schema: { title: 'string' } })
    await engine.insert('products', { title: 'Desk lamp' }, 'lamp')
    blockNextSnapshot = true
    const checkpoint = engine.checkpoint('products')
    await saveStarted.promise
    const drop = engine.dropIndex('products')
    saveGate.resolve()

    await checkpoint
    await drop

    expect(await storage.list('products/')).toEqual([])
  })

  it('rejects callers beyond the configured reopen waiter limit', async () => {
    const storage = createMemoryPersistence()
    const loadStarted = deferred()
    const loadGate = deferred()
    let blockSnapshotLoad = false
    const adapter: PersistenceAdapter = {
      save: (key, data) => storage.save(key, data),
      async load(key) {
        if (blockSnapshotLoad && key.endsWith('/snapshot')) {
          loadStarted.resolve()
          await loadGate.promise
        }
        return storage.load(key)
      },
      delete: key => storage.delete(key),
      list: prefix => storage.list(prefix),
    }
    engine = await createNarsil({ persistence: adapter, durability: { tier: 'snapshot' }, lifecycle: {} })
    await engine.createIndex('products', { schema: { title: 'string' } })
    await engine.insert('products', { title: 'Desk lamp' }, 'lamp')
    await engine.checkpoint('products')
    await engine.shutdown()
    blockSnapshotLoad = true
    engine = await createNarsil({
      persistence: adapter,
      durability: { tier: 'snapshot' },
      lifecycle: { maxReopenWaiters: 1 },
    })

    const first = engine.get('products', 'lamp')
    await loadStarted.promise
    const second = engine.get('products', 'lamp')
    const third = engine.get('products', 'lamp')
    await expect(third).rejects.toMatchObject({ code: ErrorCodes.INDEX_REOPEN_CAPACITY_EXHAUSTED })
    loadGate.resolve()
    await expect(first).resolves.toEqual({ title: 'Desk lamp' })
    await expect(second).resolves.toEqual({ title: 'Desk lamp' })
  })

  it('parks recovery after five failures until an explicit open resets it', async () => {
    const storage = createMemoryPersistence()
    let rejectSnapshotLoad = false
    let snapshotLoads = 0
    const adapter: PersistenceAdapter = {
      save: (key, data) => storage.save(key, data),
      async load(key) {
        if (rejectSnapshotLoad && key.endsWith('/snapshot')) {
          snapshotLoads += 1
          throw new Error('snapshot unavailable')
        }
        return storage.load(key)
      },
      delete: key => storage.delete(key),
      list: prefix => storage.list(prefix),
    }
    engine = await createNarsil({ persistence: adapter, durability: { tier: 'snapshot' }, lifecycle: {} })
    await engine.createIndex('products', { schema: { title: 'string' } })
    await engine.insert('products', { title: 'Desk lamp' }, 'lamp')
    await engine.checkpoint('products')
    await engine.shutdown()
    rejectSnapshotLoad = true
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    engine = await createNarsil({ persistence: adapter, durability: { tier: 'snapshot' }, lifecycle: {} })

    for (let failure = 0; failure < 5; failure += 1) {
      await expect(engine.get('products', 'lamp')).rejects.toMatchObject({
        code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
      })
      now += 10_000
    }

    expect(engine.listIndexes()[0]).toEqual(expect.objectContaining({ state: 'reopen-failed' }))
    await expect(engine.get('products', 'lamp')).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
    })
    expect(snapshotLoads).toBe(5)
    await expect(engine.open('products')).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
    })
    expect(snapshotLoads).toBe(6)
    expect(engine.listIndexes()[0]).toEqual(expect.objectContaining({ state: 'closed' }))
  })

  it('rejects lifecycle settings when no durable store is configured', async () => {
    await expect(createNarsil({ lifecycle: {} })).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
  })

  it('rejects lifecycle limits that cannot retain an open index', async () => {
    await expect(
      createNarsil({ persistence: createMemoryPersistence(), lifecycle: { maxOpenIndexes: 0 } }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
  })
})
