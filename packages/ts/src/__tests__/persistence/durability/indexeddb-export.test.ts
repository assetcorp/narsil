import 'fake-indexeddb/auto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { createIndexedDBPersistence } from '../../../persistence/indexeddb'
import type { NarsilConfig } from '../../../types/config'
import { bytesOf } from '../../e2e/portability/archive-oracle'

const DATABASE = 'notes-app'
const STORE = 'partitions'
const NOTES = 'notes'
const DIMENSION = 384
const DOCUMENT_COUNT = 6_000
const INSERT_BATCH = 500
const REMOVED = ['note-0', 'note-1999', 'note-5999']
const UPDATED = ['note-7', 'note-2500']
const LARGEST_EXPORT_TIME_AGAINST_FILESYSTEM = 5

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

async function timedExportOf(engine: Narsil): Promise<{ vectors: Map<string, number[]>; milliseconds: number }> {
  const started = performance.now()
  const vectors = await exportedVectorsOf(engine)
  return { vectors, milliseconds: performance.now() - started }
}

async function writeNotes(engine: Narsil): Promise<Map<string, number[]>> {
  const expected = new Map<string, number[]>()
  await engine.createIndex(NOTES, { schema: { title: 'string', embedding: `vector[${DIMENSION}]` } })
  for (let from = 0; from < DOCUMENT_COUNT; from += INSERT_BATCH) {
    const batch = Array.from({ length: INSERT_BATCH }, (_, at) => {
      const id = `note-${from + at}`
      expected.set(id, vectorOf(from + at))
      return { id, title: `note ${from + at}`, embedding: vectorOf(from + at) }
    })
    await engine.insertBatch(NOTES, batch)
  }
  await engine.removeBatch(NOTES, REMOVED)
  for (const id of REMOVED) expected.delete(id)
  for (const id of UPDATED) {
    const replacement = vectorOf(DOCUMENT_COUNT + id.length)
    await engine.update(NOTES, id, { title: id, embedding: replacement })
    expected.set(id, replacement)
  }
  await engine.checkpoint(NOTES)
  return expected
}

describe('a document export from IndexedDB', () => {
  const engines: Narsil[] = []
  let directory: string

  beforeEach(async () => {
    globals.indexedDB = new IDBFactory()
    directory = await mkdtemp(join(tmpdir(), 'narsil-indexeddb-export-'))
  })

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  })

  async function open(config: Partial<NarsilConfig>): Promise<Narsil> {
    const engine = await createNarsil({ workers: { enabled: false }, ...config })
    engines.push(engine)
    return engine
  }

  async function restart(engine: Narsil, config: Partial<NarsilConfig>): Promise<Narsil> {
    await engine.shutdown()
    engines.splice(engines.indexOf(engine), 1)
    return open(config)
  }

  it('exports every checkpointed vector exactly after a restart, within five times the filesystem export time', async () => {
    const indexedDB = { persistence: createIndexedDBPersistence({ dbName: DATABASE, storeName: STORE }) }
    const first = await open(indexedDB)
    const expected = await writeNotes(first)
    expect(await exportedVectorsOf(first)).toEqual(expected)

    const second = await restart(first, indexedDB)
    const fromIndexedDB = await timedExportOf(second)
    expect(fromIndexedDB.vectors).toEqual(expected)

    const archive = await bytesOf(await second.snapshot(NOTES))
    const copy = await open({})
    await copy.restore(NOTES, archive)
    expect(await exportedVectorsOf(copy)).toEqual(expected)

    const filesystem = { durability: { directory } }
    const written = await open(filesystem)
    await writeNotes(written)
    const fromFilesystem = await timedExportOf(await restart(written, filesystem))
    expect(fromFilesystem.vectors).toEqual(expected)
    expect(fromIndexedDB.milliseconds).toBeLessThanOrEqual(
      LARGEST_EXPORT_TIME_AGAINST_FILESYSTEM * fromFilesystem.milliseconds,
    )
  }, 120_000)
})
