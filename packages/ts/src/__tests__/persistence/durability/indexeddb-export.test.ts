import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { createIndexedDBPersistence } from '../../../persistence/indexeddb'
import { bytesOf } from '../../e2e/portability/archive-oracle'

const DATABASE = 'notes-app'
const STORE = 'partitions'
const NOTES = 'notes'
const DIMENSION = 384
const DOCUMENT_COUNT = 6_000
const INSERT_BATCH = 500
const REMOVED = ['note-0', 'note-1999', 'note-5999']
const UPDATED = ['note-7', 'note-2500']

const globals = globalThis as { indexedDB: IDBFactory }

function vectorOf(seed: number): number[] {
  let state = (seed * 2_654_435_761 + 97) >>> 0
  return Array.from({ length: DIMENSION }, () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0
    return Math.fround(state / 2 ** 32 - 0.5)
  })
}

async function exportedVectorsOf(engine: Narsil): Promise<Map<string, number[]>> {
  const text = new TextDecoder().decode(await bytesOf(await engine.exportDocuments(NOTES)))
  const lines = text.split('\n').filter(line => line.length > 0)
  const vectors = new Map<string, number[]>()
  for (const line of lines.slice(1)) {
    const document = JSON.parse(line) as { id: string; embedding: number[] }
    vectors.set(document.id, document.embedding)
  }
  return vectors
}

describe('a document export from IndexedDB', () => {
  const engines: Narsil[] = []

  beforeEach(() => {
    globals.indexedDB = new IDBFactory()
  })

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  })

  async function open(): Promise<Narsil> {
    const engine = await createNarsil({
      persistence: createIndexedDBPersistence({ dbName: DATABASE, storeName: STORE }),
      workers: { enabled: false },
    })
    engines.push(engine)
    return engine
  }

  it('returns every checkpointed vector exactly in an export and a snapshot, before and after a restart', async () => {
    const expected = new Map<string, number[]>()
    const first = await open()
    await first.createIndex(NOTES, { schema: { title: 'string', embedding: `vector[${DIMENSION}]` } })
    for (let from = 0; from < DOCUMENT_COUNT; from += INSERT_BATCH) {
      const batch = Array.from({ length: INSERT_BATCH }, (_, at) => {
        const id = `note-${from + at}`
        expected.set(id, vectorOf(from + at))
        return { id, title: `note ${from + at}`, embedding: vectorOf(from + at) }
      })
      await first.insertBatch(NOTES, batch)
    }
    await first.removeBatch(NOTES, REMOVED)
    for (const id of REMOVED) expected.delete(id)
    for (const id of UPDATED) {
      const replacement = vectorOf(DOCUMENT_COUNT + expected.size + id.length)
      await first.update(NOTES, id, { title: id, embedding: replacement })
      expected.set(id, replacement)
    }
    await first.checkpoint(NOTES)

    expect(await exportedVectorsOf(first)).toEqual(expected)
    await first.shutdown()
    engines.splice(0)

    const second = await open()
    expect(await exportedVectorsOf(second)).toEqual(expected)

    const archive = await bytesOf(await second.snapshot(NOTES))
    const copy = await createNarsil({ workers: { enabled: false } })
    engines.push(copy)
    await copy.restore(NOTES, archive)
    expect(await exportedVectorsOf(copy)).toEqual(expected)
  }, 20_000)
})
