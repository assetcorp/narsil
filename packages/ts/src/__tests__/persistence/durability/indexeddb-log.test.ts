import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNoopInvalidation } from '../../../invalidation/noop'
import { createNarsil, type Narsil } from '../../../narsil'
import { createIndexedDBPersistence } from '../../../persistence/indexeddb'
import type { DurabilityConfig, NarsilConfig } from '../../../types/config'
import { bodyOf, expectDocumentsOf } from './saved-size-oracle'

const DATABASE = 'notes-app'
const STORE = 'partitions'
const NOTES = 'notes'
const SCHEMA = { schema: { title: 'string', body: 'string' } } as const

const globals = globalThis as { indexedDB: IDBFactory }

function requestDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DATABASE)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
  }
  return requestDone(request)
}

async function committedRecordsOf(factory: IDBFactory): Promise<Array<[IDBValidKey, unknown]>> {
  const database = await openDatabase(factory)
  try {
    const store = database.transaction(STORE, 'readonly').objectStore(STORE)
    const [keys, values] = await Promise.all([requestDone(store.getAllKeys()), requestDone(store.getAll())])
    return keys.map((key, at) => [key, values[at]])
  } finally {
    database.close()
  }
}

async function storeAfterTheTabCloses(running: IDBFactory): Promise<IDBFactory> {
  const records = await committedRecordsOf(running)
  const reopened = new IDBFactory()
  const database = await openDatabase(reopened)
  const transaction = database.transaction(STORE, 'readwrite')
  for (const [key, value] of records) transaction.objectStore(STORE).put(value, key)
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
  database.close()
  return reopened
}

describe('the write-ahead log in IndexedDB', () => {
  const engines: Narsil[] = []

  beforeEach(() => {
    globals.indexedDB = new IDBFactory()
  })

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  })

  async function open(durability?: DurabilityConfig, extra: Partial<NarsilConfig> = {}): Promise<Narsil> {
    const engine = await createNarsil({
      persistence: createIndexedDBPersistence({ dbName: DATABASE, storeName: STORE }),
      ...(durability === undefined ? {} : { durability }),
      workers: { enabled: false },
      ...extra,
    })
    engines.push(engine)
    return engine
  }

  async function closeTheTab(engine: Narsil): Promise<void> {
    const reopened = await storeAfterTheTabCloses(globals.indexedDB)
    await engine.shutdown()
    globals.indexedDB = reopened
  }

  async function writeNotes(engine: Narsil, expected: Map<string, string>, from: number, count: number): Promise<void> {
    for (let at = from; at < from + count; at++) {
      await engine.insert(NOTES, { title: `note ${at}`, body: bodyOf(at, 90) }, `note-${at}`)
      expected.set(`note-${at}`, bodyOf(at, 90))
    }
  }

  it('keeps every write that sync mode acknowledged when the tab closes, across a checkpoint and two closes', async () => {
    const expected = new Map<string, string>()
    const first = await open()
    await first.createIndex(NOTES, SCHEMA)
    await writeNotes(first, expected, 0, 20)
    await first.checkpoint(NOTES)
    await writeNotes(first, expected, 20, 15)
    await first.insertBatch(
      NOTES,
      Array.from({ length: 40 }, (_, at) => ({ id: `batch-${at}`, title: `batch ${at}`, body: bodyOf(at + 300, 70) })),
    )
    for (let at = 0; at < 40; at++) expected.set(`batch-${at}`, bodyOf(at + 300, 70))
    await first.update(NOTES, 'note-4', { title: 'note 4', body: bodyOf(7_000, 90) })
    expected.set('note-4', bodyOf(7_000, 90))
    await first.removeBatch(NOTES, ['note-1', 'note-25', 'batch-0'])
    for (const docId of ['note-1', 'note-25', 'batch-0']) expected.delete(docId)
    await closeTheTab(first)

    const second = await open()
    await expectDocumentsOf(second, NOTES, expected, ['note-1', 'note-25', 'batch-0'])
    await writeNotes(second, expected, 100, 10)
    await second.remove(NOTES, 'note-2')
    expected.delete('note-2')
    await closeTheTab(second)

    const third = await open()
    await expectDocumentsOf(third, NOTES, expected, ['note-1', 'note-2', 'note-25', 'batch-0'])
  })

  it('keeps every write that async mode acknowledged when the tab closes before the next flush', async () => {
    const expected = new Map<string, string>()
    const first = await open({ mode: 'async', flushIntervalMs: 600_000 })
    await first.createIndex(NOTES, SCHEMA)
    await writeNotes(first, expected, 0, 30)
    await first.remove(NOTES, 'note-9')
    expected.delete('note-9')
    await closeTheTab(first)

    const second = await open({ mode: 'async', flushIntervalMs: 600_000 })
    await expectDocumentsOf(second, NOTES, expected, ['note-9'])
  })

  it('opens an index that the snapshot tier saved, and logs the writes that follow', async () => {
    const expected = new Map<string, string>()
    const saved = await open({ tier: 'snapshot' })
    await saved.createIndex(NOTES, SCHEMA)
    await writeNotes(saved, expected, 0, 12)
    await saved.shutdown()

    const logged = await open()
    await expectDocumentsOf(logged, NOTES, expected, [])
    await writeNotes(logged, expected, 12, 8)
    await closeTheTab(logged)

    const reopened = await open()
    await expectDocumentsOf(reopened, NOTES, expected, [])
  })

  it('keeps a restored snapshot that replaces a logged index, and the writes after it, when the tab closes', async () => {
    const source = await createNarsil({ workers: { enabled: false } })
    engines.push(source)
    await source.createIndex(NOTES, SCHEMA)
    const expected = new Map<string, string>()
    await writeNotes(source, expected, 500, 30)
    const snapshot = new Uint8Array(await new Response(await source.snapshot(NOTES)).arrayBuffer())

    const engine = await open()
    await engine.createIndex(NOTES, SCHEMA)
    await writeNotes(engine, new Map(), 0, 12)
    await engine.checkpoint(NOTES)
    await writeNotes(engine, new Map(), 12, 4)
    await engine.restore(NOTES, snapshot)
    await writeNotes(engine, expected, 600, 6)
    await closeTheTab(engine)

    const reopened = await open()
    await expectDocumentsOf(reopened, NOTES, expected, ['note-0', 'note-11', 'note-15'])
  })

  it('refuses a second engine on the same store, and names what several tabs need', async () => {
    await open()
    const second = createNarsil({
      persistence: createIndexedDBPersistence({ dbName: DATABASE, storeName: STORE }),
      workers: { enabled: false },
    })
    await expect(second).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await expect(second).rejects.toThrow(/invalidation adapter or durability\.tier "snapshot"/)
  })

  it('keeps sharing one store between tabs on the snapshot tier where an invalidation adapter is set', async () => {
    const expected = new Map<string, string>()
    const first = await open(undefined, { invalidation: createNoopInvalidation() })
    const second = await open(undefined, { invalidation: createNoopInvalidation() })
    await first.createIndex(NOTES, SCHEMA)
    await writeNotes(first, expected, 0, 5)
    await first.shutdown()
    await second.shutdown()

    const reopened = await open()
    await expectDocumentsOf(reopened, NOTES, expected, [])
  })

  it('stops acknowledging writes once another connection asks to upgrade the database', async () => {
    const errors: Error[] = []
    const engine = await open()
    engine.on('durabilityError', ({ error }) => errors.push(error))
    await engine.createIndex(NOTES, SCHEMA)
    await engine.insert(NOTES, { title: 'kept', body: bodyOf(1, 40) }, 'kept')

    const upgrade = globals.indexedDB.open(DATABASE, 2)
    await requestDone(upgrade)
    upgrade.result.close()

    await expect(engine.insert(NOTES, { title: 'refused', body: bodyOf(2, 40) }, 'refused')).rejects.toMatchObject({
      code: 'PERSISTENCE_SAVE_FAILED',
    })
    expect(errors.some(error => (error as { code?: string }).code === 'PERSISTENCE_SAVE_FAILED')).toBe(true)
  })

  it('refuses an append record with an extra key component before replaying its bytes', async () => {
    const engine = await open()
    await engine.createIndex(NOTES, SCHEMA)
    await engine.insert(NOTES, { title: 'kept', body: 'acknowledged content' }, 'kept')
    await engine.shutdown()
    const database = await openDatabase(globals.indexedDB)
    try {
      const transaction = database.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      const keys = await requestDone(store.getAllKeys())
      const key = keys.find(key => Array.isArray(key))
      if (!Array.isArray(key)) throw new Error('The write produced no append record')
      const bytes: unknown = await requestDone(store.get(key))
      await requestDone(store.delete(key))
      await requestDone(store.put(bytes, [...key, 'foreign']))
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      database.close()
    }
    await expect(open()).rejects.toMatchObject({ code: 'PERSISTENCE_LOAD_FAILED' })
  })

  it('refuses an async append whose transaction completes after a version change request', async () => {
    const engine = await open({ mode: 'async', flushIntervalMs: 600_000, checkpointIntervalMs: 0 })
    const errors: Error[] = []
    engine.on('durabilityError', ({ error }) => errors.push(error))
    await engine.createIndex(NOTES, SCHEMA)
    await engine.insert(NOTES, { title: 'kept', body: 'before the version change' }, 'kept')
    const database = await openDatabase(globals.indexedDB)
    let holding = true
    const transaction = database.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    function keepTransactionOpen(): void {
      const request = store.get('notes/meta')
      request.onsuccess = () => {
        if (holding) keepTransactionOpen()
      }
    }
    keepTransactionOpen()
    database.onversionchange = () => {
      holding = false
      database.close()
    }
    const pending = engine.insert(NOTES, { title: 'refused', body: 'during the version change' }, 'refused')
    const outcome = pending.then(
      () => null,
      error => error as unknown,
    )
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      const upgrade = await requestDone(globals.indexedDB.open(DATABASE, 2))
      upgrade.close()
      expect(await outcome).toMatchObject({ code: 'PERSISTENCE_SAVE_FAILED' })
      expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PERSISTENCE_SAVE_FAILED' })]))
    } finally {
      holding = false
      database.close()
      await outcome
    }
  })

  it('refuses stored undefined metadata without silently hiding the index', async () => {
    const engine = await open()
    await engine.createIndex(NOTES, SCHEMA)
    await engine.insert(NOTES, { title: 'kept', body: 'acknowledged content' }, 'kept')
    await engine.shutdown()
    const database = await openDatabase(globals.indexedDB)
    try {
      const transaction = database.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(undefined, `${NOTES}/meta`)
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      database.close()
    }
    await expect(open()).rejects.toMatchObject({ code: 'PERSISTENCE_LOAD_FAILED' })
  })
})
