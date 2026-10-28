import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AnyDocument } from '../../../types/schema'
import { INDEX, registerWorkshopLanguage, workshopCorpus } from '../partial-words/corpus'
import {
  createWorkshopIndex,
  expectSameHits,
  insertAll,
  NO_WORKERS,
  searchOver,
  startWorkshopServer,
  WORKERS_BUILT,
  type WorkshopServer,
  waitForWorkerCopies,
  workerCopies,
} from '../partial-words/harness'
import { createOracle, type OracleQuery } from '../partial-words/oracle'

const PAINTING_DOCUMENTS: AnyDocument[] = [
  { id: 'painting-bench', title: 'coat', body: 'painting bench' },
  { id: 'painting-twice', title: 'boat', body: 'painting chair painting' },
]
const PAINT_ONLY: AnyDocument = { id: 'paint-only', title: 'mill', body: 'paint lamp' }
const SPELLING_QUERIES: OracleQuery[] = [
  { term: 'painti', prefix: true },
  { term: 'paintin', prefix: true },
  { term: 'painti', prefix: true, fields: ['body'] },
  { term: 'lamp painti', prefix: true },
  { term: 'painting' },
  { term: 'paint' },
  { term: 'paint', prefix: true },
]

const servers: WorkshopServer[] = []
let directory: string | null = null

beforeAll(() => {
  registerWorkshopLanguage()
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  if (directory !== null) await rm(directory, { recursive: true, force: true })
  directory = null
})

async function started(config: Parameters<typeof startWorkshopServer>[0]): Promise<WorkshopServer> {
  const server = await startWorkshopServer(config)
  servers.push(server)
  return server
}

async function expectSpellingQueries(
  server: WorkshopServer,
  documents: readonly AnyDocument[],
  label: string,
): Promise<void> {
  const oracle = createOracle(documents)
  const search = searchOver(server.client)
  for (const query of SPELLING_QUERIES) {
    expectSameHits(await search(query), oracle.search(query), `${label} ${JSON.stringify(query)}`)
  }
}

async function removePaintings(server: WorkshopServer): Promise<void> {
  const removed = await server.client.removeBatch(
    INDEX,
    PAINTING_DOCUMENTS.map(document => String(document.id)),
  )
  expect(removed.failed).toEqual([])
}

async function segmentFilesOf(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true })
  return entries.filter(entry => /segments\/0\/s\d+$/.test(entry))
}

describe('a prefix that only a removed stemmed spelling completed stops completing it', () => {
  it.skipIf(!WORKERS_BUILT)(
    'on worker copies, while the stem stays in other documents',
    async () => {
      const kept = [...workshopCorpus(300, 81), PAINT_ONLY]
      const server = await started({ workers: workerCopies() })
      await createWorkshopIndex(server, [...kept, ...PAINTING_DOCUMENTS])
      await waitForWorkerCopies(server)
      await expectSpellingQueries(server, [...kept, ...PAINTING_DOCUMENTS], 'workers loaded')

      await removePaintings(server)
      await server.client.waitForWrites(INDEX)
      await expectSpellingQueries(server, kept, 'workers removed')

      await insertAll(server, [PAINTING_DOCUMENTS[0]])
      await server.client.waitForWrites(INDEX)
      await expectSpellingQueries(server, [...kept, PAINTING_DOCUMENTS[0]], 'workers returned')
    },
    60_000,
  )

  it('on the main thread after a restart, whether the removal arrives after the restart or replays at it', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-stemmed-spellings-'))
    const durability = { directory }
    const kept = [...workshopCorpus(300, 82), PAINT_ONLY]
    const first = await startWorkshopServer({ workers: NO_WORKERS, durability })
    await createWorkshopIndex(first, [...kept, ...PAINTING_DOCUMENTS])
    await first.client.checkpoint(INDEX)
    await first.stop()

    const second = await startWorkshopServer({ workers: NO_WORKERS, durability })
    await expectSpellingQueries(second, [...kept, ...PAINTING_DOCUMENTS], 'restarted')
    await removePaintings(second)
    await expectSpellingQueries(second, kept, 'removed after the restart')
    await second.stop()

    const third = await started({ workers: NO_WORKERS, durability })
    await expectSpellingQueries(third, kept, 'removal replayed')
  }, 60_000)

  it('after a checkpoint merges the removal into the segment that held the spelling', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-stemmed-spellings-merged-'))
    const durability = { directory, compactionThreshold: 1 }
    const kept = [...workshopCorpus(300, 83), PAINT_ONLY]
    const first = await startWorkshopServer({ workers: NO_WORKERS, durability })
    await createWorkshopIndex(first, [...kept, ...PAINTING_DOCUMENTS])
    await first.client.checkpoint(INDEX)
    await first.stop()

    const second = await startWorkshopServer({ workers: NO_WORKERS, durability })
    await removePaintings(second)
    await second.client.checkpoint(INDEX)
    await second.stop()
    expect(await segmentFilesOf(directory)).toHaveLength(1)

    const third = await started({ workers: NO_WORKERS, durability })
    await expectSpellingQueries(third, kept, 'merged')
    await insertAll(third, [PAINTING_DOCUMENTS[1]])
    await expectSpellingQueries(third, [...kept, PAINTING_DOCUMENTS[1]], 'returned after the merge')
  }, 60_000)
})
