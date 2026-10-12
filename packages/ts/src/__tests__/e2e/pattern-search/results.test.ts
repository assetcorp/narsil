import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NarsilConfig } from '../../../types/config'
import type { FieldFilter } from '../../../types/filters'
import type { AnyDocument } from '../../../types/schema'
import { EDGE_PROBES, generatedProbes, INDEX, operationsCorpus, type PatternField } from './corpus'
import {
  countOf,
  listIds,
  loadCorpus,
  NO_WORKERS,
  type PatternServer,
  searchIds,
  startPatternServer,
  WORKER_COPIES,
  WORKERS_BUILT,
} from './harness'
import { expectedIds } from './oracle'

const CORPUS_SIZE = 2_000
const GENERATED_PROBES = 300

const servers: PatternServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

async function started(config: NarsilConfig): Promise<PatternServer> {
  const server = await startPatternServer(config)
  servers.push(server)
  return server
}

function probesFor(documents: readonly AnyDocument[], seed: number): Array<[PatternField, FieldFilter]> {
  return [...EDGE_PROBES, ...generatedProbes(documents, GENERATED_PROBES, seed)]
}

async function expectEveryProbe(server: PatternServer, documents: readonly AnyDocument[], seed: number): Promise<void> {
  for (const [field, filter] of probesFor(documents, seed)) {
    const label = `${field} ${JSON.stringify(filter)}`
    const expected = expectedIds(documents, field, filter)
    expect(await searchIds(server, field, filter), label).toEqual(expected)
    expect(await listIds(server, field, filter), label).toEqual(expected)
    expect(await countOf(server, field, filter), label).toBe(expected.length)
  }
}

function rewritten(document: AnyDocument, at: number): AnyDocument {
  const line = `2025-01-01T00:00:00Z FATAL [Straße-Router] rewritten ${at} ΣΊΣΥΦΟΣ`
  const changed: AnyDocument = { ...document, line }
  if (at % 2 === 0) delete changed.sku
  if (at % 4 === 1) changed.emails = []
  return changed
}

describe.each([
  { where: 'on the main thread', config: { workers: NO_WORKERS }, runnable: true },
  { where: 'on worker copies', config: { workers: WORKER_COPIES }, runnable: WORKERS_BUILT },
])('a pattern search sent over HTTP $where', ({ config, runnable }) => {
  it.skipIf(!runnable)(
    'returns exactly the documents that pass each test, in a search, a document list, and a count',
    async () => {
      const documents = operationsCorpus(CORPUS_SIZE, 11)
      const server = await started(config)
      await loadCorpus(server, documents)
      await expectEveryProbe(server, documents, 101)
    },
    180_000,
  )

  it.skipIf(!runnable)(
    'returns the documents as they stand after updates, removals, and new inserts',
    async () => {
      const documents = operationsCorpus(CORPUS_SIZE, 12)
      const server = await started(config)
      await loadCorpus(server, documents)

      const updates = documents.filter((_, at) => at % 3 === 0).map((document, at) => rewritten(document, at))
      const updated = await server.client.updateBatch(
        INDEX,
        updates.map(document => ({ docId: String(document.id), document })),
      )
      expect(updated.failed).toEqual([])
      const removed = documents.filter((_, at) => at % 5 === 1).map(document => String(document.id))
      const removal = await server.client.removeBatch(INDEX, removed)
      expect(removal.failed).toEqual([])
      const additions = operationsCorpus(300, 13).map(document => ({ ...document, id: `new-${document.id}` }))
      const added = await server.client.insertBatch(INDEX, additions)
      expect(added.failed).toEqual([])
      await server.client.waitForWrites(INDEX)

      const byId = new Map(documents.map(document => [String(document.id), document]))
      for (const document of updates) byId.set(String(document.id), document)
      for (const id of removed) byId.delete(id)
      for (const document of additions) byId.set(String(document.id), document)
      await expectEveryProbe(server, [...byId.values()], 102)
    },
    180_000,
  )
})

describe('a pattern search after the server restarts or restores a snapshot', () => {
  let directory: string | null = null

  afterEach(async () => {
    if (directory !== null) await rm(directory, { recursive: true, force: true })
    directory = null
  })

  it('returns the same documents from the durable log after a restart', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-pattern-e2e-'))
    const documents = operationsCorpus(CORPUS_SIZE, 14)
    const first = await startPatternServer({ workers: NO_WORKERS, durability: { directory } })
    await loadCorpus(first, documents)
    await first.client.checkpoint(INDEX)
    const late = operationsCorpus(200, 15).map(document => ({ ...document, id: `late-${document.id}` }))
    expect((await first.client.insertBatch(INDEX, late)).failed).toEqual([])
    await first.stop()

    const second = await started({ workers: NO_WORKERS, durability: { directory } })
    await expectEveryProbe(second, [...documents, ...late], 103)
  }, 180_000)

  it('returns the same documents from a snapshot restored into another server', async () => {
    const documents = operationsCorpus(CORPUS_SIZE, 16)
    const source = await started({ workers: NO_WORKERS })
    await loadCorpus(source, documents)
    const snapshot = await source.client.snapshot(INDEX)

    const target = await started({ workers: NO_WORKERS })
    const task = await target.client.restore(INDEX, snapshot)
    expect((await target.client.waitForTask(task.id)).status).toBe('succeeded')
    await expectEveryProbe(target, documents, 104)
  }, 180_000)
})
