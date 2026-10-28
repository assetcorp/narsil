import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AnyDocument } from '../../../types/schema'
import { seededRandom } from '../../filters/pattern/random-corpus'
import { BODY, INDEX, registerWorkshopLanguage, TITLE_WORDS } from '../partial-words/corpus'
import {
  createWorkshopIndex,
  expectEveryProbe,
  expectSameHits,
  type HitComparison,
  insertAll,
  NO_WORKERS,
  type SearchFn,
  searchOver,
  startWorkshopServer,
  WORKERS_BUILT,
  type WorkshopServer,
  waitForWorkerCopies,
  workerCopies,
} from '../partial-words/harness'
import { createOracle, type OracleQuery } from '../partial-words/oracle'
import { bytesOf } from '../portability/archive-oracle'
import { expectedPositions, storedPositions } from './stored-positions'

const LOADED_DOCUMENTS = 4_000
const SERIALS_PER_DOCUMENT = 6
const SURVIVOR_EVERY = 8
const FILLER = ['bench', 'table', 'paint', 'brush', 'chair', 'lamp']

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

function serialWord(serial: number): string {
  return `u${serial}x`
}

function distinctTermCorpus(count: number, seed: number, idPrefix: string, firstSerial: number): AnyDocument[] {
  const random = seededRandom(seed)
  const pick = (pool: readonly string[]): string => pool[Math.floor(random() * pool.length)]
  return Array.from({ length: count }, (_, at) => {
    const serials = Array.from({ length: SERIALS_PER_DOCUMENT }, (_, slot) =>
      serialWord(firstSerial + at * SERIALS_PER_DOCUMENT + slot),
    )
    const shared = Array.from({ length: 2 + Math.floor(random() * 4) }, () => pick([...TITLE_WORDS, ...FILLER]))
    return {
      id: `${idPrefix}${String(at).padStart(5, '0')}`,
      title: Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(TITLE_WORDS)).join(' '),
      body: [...shared.slice(0, 2), ...serials, ...shared.slice(2)].join(' '),
    }
  })
}

function serialQueries(documents: readonly AnyDocument[], removed: readonly AnyDocument[]): OracleQuery[] {
  const queries: OracleQuery[] = []
  const sample = (pool: readonly AnyDocument[]) => pool.filter((_, at) => at % 97 === 0)
  for (const document of [...sample(documents), ...sample(removed)]) {
    const words = String(document.body)
      .split(' ')
      .filter(word => word.startsWith('u'))
    const first = words[0]
    if (first === undefined) continue
    queries.push({ term: first })
    queries.push({ term: `${first.slice(0, -1)}y`, tolerance: 1 })
    queries.push({ term: words.slice(0, 3).join(' '), termMatch: 'all' })
    queries.push({ term: `paint ${words[words.length - 1]}` })
  }
  queries.push({ term: 'u12', prefix: true })
  queries.push({ term: 'u2000', prefix: true })
  return queries
}

async function expectSerialQueries(
  search: SearchFn,
  documents: readonly AnyDocument[],
  removed: readonly AnyDocument[],
  label: string,
  comparison: HitComparison = 'ids and scores',
): Promise<void> {
  const oracle = createOracle(documents)
  for (const query of serialQueries(documents, removed)) {
    expectSameHits(await search(query), oracle.search(query), `${label} ${JSON.stringify(query)}`, comparison)
  }
}

async function churn(server: WorkshopServer, documents: readonly AnyDocument[]) {
  const removed = documents.filter((_, at) => at % SURVIVOR_EVERY !== 0)
  expect(
    (
      await server.client.removeBatch(
        INDEX,
        removed.map(document => String(document.id)),
      )
    ).failed,
  ).toEqual([])
  const survivors = documents.filter((_, at) => at % SURVIVOR_EVERY === 0)

  const returning = removed.slice(0, 300).map((document, at) => ({
    ...document,
    body: `${String(document.body)} ${serialWord(900_000 + at)}`,
  }))
  await insertAll(server, returning)
  const rewritten = survivors.slice(0, 200).map(document => ({
    docId: String(document.id),
    document: { ...document, body: `paint ${serialWord(950_000 + Number(String(document.id).slice(-5)))}` },
  }))
  expect((await server.client.updateBatch(INDEX, rewritten)).failed).toEqual([])

  const current = new Map(survivors.map(document => [String(document.id), document]))
  for (const document of returning) current.set(String(document.id), document)
  for (const { docId, document } of rewritten) current.set(docId, document)
  const gone = removed.slice(300)
  return { current: [...current.values()], gone }
}

describe('a text index holding tens of thousands of distinct terms matches the independent oracle', () => {
  it('on the main thread, after most of its terms leave and some come back', async () => {
    const documents = distinctTermCorpus(LOADED_DOCUMENTS, 91, 'serial', 0)
    const server = await started({ workers: NO_WORKERS })
    await createWorkshopIndex(server, documents)
    const search = searchOver(server.client)
    await expectEveryProbe(search, createOracle(documents), 'loaded')
    await expectSerialQueries(search, documents, [], 'loaded')

    const { current, gone } = await churn(server, documents)
    await expectEveryProbe(search, createOracle(current), 'churned')
    await expectSerialQueries(search, current, gone, 'churned')

    const later = distinctTermCorpus(1_500, 92, 'later', 500_000)
    await insertAll(server, later)
    await expectEveryProbe(search, createOracle([...current, ...later]), 'grown again')
    await expectSerialQueries(search, [...current, ...later], gone, 'grown again')
  }, 300_000)

  it('after a snapshot of the churned index is restored into another server', async () => {
    const documents = distinctTermCorpus(LOADED_DOCUMENTS, 93, 'serial', 0)
    const source = await started({ workers: NO_WORKERS })
    await createWorkshopIndex(source, documents)
    const { current, gone } = await churn(source, documents)
    const snapshot = await bytesOf(await source.client.snapshot(INDEX))
    expect(storedPositions(snapshot, BODY)).toEqual(expectedPositions(current, BODY))

    const target = await started({ workers: NO_WORKERS })
    const task = await target.client.restore(INDEX, snapshot)
    expect((await target.client.waitForTask(task.id)).status).toBe('succeeded')
    await expectEveryProbe(searchOver(target.client), createOracle(current), 'restored')
    await expectSerialQueries(searchOver(target.client), current, gone, 'restored')
  }, 300_000)

  it('after a restart replays writes logged over a checkpoint of the churned index', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-distinct-terms-'))
    const documents = distinctTermCorpus(LOADED_DOCUMENTS, 94, 'serial', 0)
    const first = await startWorkshopServer({ workers: NO_WORKERS, durability: { directory } })
    await createWorkshopIndex(first, documents)
    const { current, gone } = await churn(first, documents)
    await first.client.checkpoint(INDEX)
    const late = distinctTermCorpus(400, 95, 'logged', 700_000)
    await insertAll(first, late)
    await first.stop()

    const second = await started({ workers: NO_WORKERS, durability: { directory } })
    await expectEveryProbe(searchOver(second.client), createOracle([...current, ...late]), 'restarted')
    await expectSerialQueries(searchOver(second.client), [...current, ...late], gone, 'restarted')
  }, 300_000)

  it('reports no more memory after most of its terms leave than a fresh index of the documents that stay', async () => {
    const documents = distinctTermCorpus(LOADED_DOCUMENTS, 97, 'serial', 0)
    const churned = await started({ workers: NO_WORKERS })
    await createWorkshopIndex(churned, documents)
    const loadedBytes = (await churned.client.getStats(INDEX)).estimatedMemoryBytes
    const removed = documents.filter((_, at) => at % SURVIVOR_EVERY !== 0)
    expect(
      (
        await churned.client.removeBatch(
          INDEX,
          removed.map(document => String(document.id)),
        )
      ).failed,
    ).toEqual([])
    const churnedBytes = (await churned.client.getStats(INDEX)).estimatedMemoryBytes

    const survivors = documents.filter((_, at) => at % SURVIVOR_EVERY === 0)
    const fresh = await started({ workers: NO_WORKERS })
    await createWorkshopIndex(fresh, survivors)
    const freshBytes = (await fresh.client.getStats(INDEX)).estimatedMemoryBytes

    expect(freshBytes).toBeLessThan(loadedBytes / 4)
    expect(churnedBytes).toBeLessThan(freshBytes * 1.25)
    await expectSerialQueries(searchOver(churned.client), survivors, removed, 'churned')
  }, 300_000)

  it.skipIf(!WORKERS_BUILT)(
    'on worker copies, after the churn reaches them',
    async () => {
      const documents = distinctTermCorpus(LOADED_DOCUMENTS, 96, 'serial', 0)
      const server = await started({ workers: workerCopies() })
      await createWorkshopIndex(server, documents)
      await waitForWorkerCopies(server)
      const { current, gone } = await churn(server, documents)
      await server.client.waitForWrites(INDEX)
      const search = searchOver(server.client)
      await expectEveryProbe(search, createOracle(current), 'workers churned')
      await expectSerialQueries(search, current, gone, 'workers churned')
    },
    300_000,
  )
})
