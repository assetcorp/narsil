import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import { INDEX, registerWorkshopLanguage, workshopCorpus } from '../e2e/partial-words/corpus'
import {
  expectEveryProbe,
  hitsOf,
  NO_WORKERS,
  RESULT_LIMIT,
  type SearchFn,
  WORKERS_BUILT,
  WORKSHOP_INDEX_CONFIG,
  workerCopies,
} from '../e2e/partial-words/harness'
import { createOracle } from '../e2e/partial-words/oracle'
import { scaledOut, waitFor } from '../server/helpers'

const DOCUMENTS = 1_600
const CORPUS_SEED = 67
const REMOVAL_STRIDE = 7
const COPY_WAIT_MS = 30_000
const STORAGES = ['memory', 'disk'] as const

const engines: Narsil[] = []
const directories: string[] = []

beforeAll(() => {
  registerWorkshopLanguage()
})

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

function searchOn(engine: Narsil): SearchFn {
  return async query => hitsOf(await engine.query(INDEX, { ...query, limit: RESULT_LIMIT } as QueryParams))
}

async function scratchDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `narsil-copy-settling-${label}-`))
  directories.push(directory)
  return directory
}

async function open(config: Parameters<typeof createNarsil>[0]): Promise<Narsil> {
  const engine = await createNarsil(config)
  engines.push(engine)
  return engine
}

async function waitForCopies(engine: Narsil): Promise<void> {
  await waitFor(async () => {
    await engine.query(INDEX, { term: 'workshop' })
    return scaledOut(engine, INDEX)
  }, COPY_WAIT_MS)
}

class HeldDocuments {
  private documents: AnyDocument[]
  private step = 0

  constructor(documents: readonly AnyDocument[]) {
    this.documents = [...documents]
  }

  takeLeaving(): string[] {
    const step = this.step++
    const leaving = this.documents
      .filter((_, at) => at % REMOVAL_STRIDE === step % REMOVAL_STRIDE)
      .map(document => String(document.id))
    const gone = new Set(leaving)
    this.documents = this.documents.filter(document => !gone.has(String(document.id)))
    return leaving
  }

  current(): AnyDocument[] {
    return [...this.documents]
  }
}

async function expectRestoredSnapshotMatches(
  archive: ReadableStream<Uint8Array>,
  held: readonly AnyDocument[],
): Promise<void> {
  const restored = await open({ durability: { directory: await scratchDirectory('restored') }, workers: NO_WORKERS })
  await restored.restore(INDEX, archive)
  expect(await restored.countDocuments(INDEX)).toBe(held.length)
  await expectEveryProbe(searchOn(restored), createOracle(held), 'restored from the snapshot taken after the removal')
}

describe.skipIf(!WORKERS_BUILT)(
  'pending frozen removals settle before reads on the main copy while worker copies follow',
  () => {
    it.each(
      STORAGES,
    )('a count, a snapshot, and a checkpoint straight after a removal batch each see it on a durable %s index', async storage => {
      const documents = workshopCorpus(DOCUMENTS, CORPUS_SEED)
      const directory = await scratchDirectory(storage)
      const writer = await createNarsil({ durability: { directory }, workers: NO_WORKERS })
      await writer.createIndex(INDEX, { ...WORKSHOP_INDEX_CONFIG, textStorage: storage })
      expect((await writer.insertBatch(INDEX, documents)).failed).toEqual([])
      await writer.checkpoint(INDEX)
      await writer.shutdown()

      const engine = await open({ durability: { directory }, workers: workerCopies() })
      await waitForCopies(engine)
      const held = new HeldDocuments(documents)

      expect((await engine.removeBatch(INDEX, held.takeLeaving())).failed).toEqual([])
      expect(await engine.countDocuments(INDEX)).toBe(held.current().length)

      expect((await engine.removeBatch(INDEX, held.takeLeaving())).failed).toEqual([])
      const archive = await engine.snapshot(INDEX)
      await expectRestoredSnapshotMatches(archive, held.current())

      expect((await engine.removeBatch(INDEX, held.takeLeaving())).failed).toEqual([])
      await engine.checkpoint(INDEX)
      await engine.waitForWrites(INDEX)
      await expectEveryProbe(searchOn(engine), createOracle(held.current()), 'answered by the worker copies')
      engines.splice(engines.indexOf(engine), 1)
      await engine.shutdown()

      const reopened = await open({ durability: { directory }, workers: NO_WORKERS })
      expect(await reopened.countDocuments(INDEX)).toBe(held.current().length)
      await expectEveryProbe(searchOn(reopened), createOracle(held.current()), 'reopened from the checkpoint')
    }, 240_000)

    it('a snapshot of an index held only in memory sees the removal batch that ran just before it', async () => {
      const documents = workshopCorpus(DOCUMENTS, CORPUS_SEED + 1)
      const engine = await open({ workers: workerCopies() })
      await engine.createIndex(INDEX, WORKSHOP_INDEX_CONFIG)
      expect((await engine.insertBatch(INDEX, documents)).failed).toEqual([])
      await waitForCopies(engine)
      const held = new HeldDocuments(documents)

      expect((await engine.removeBatch(INDEX, held.takeLeaving())).failed).toEqual([])
      await expectRestoredSnapshotMatches(await engine.snapshot(INDEX), held.current())

      expect((await engine.removeBatch(INDEX, held.takeLeaving())).failed).toEqual([])
      expect(await engine.countDocuments(INDEX)).toBe(held.current().length)
      await engine.waitForWrites(INDEX)
      await expectEveryProbe(searchOn(engine), createOracle(held.current()), 'answered by the worker copies')
    }, 240_000)
  },
)
