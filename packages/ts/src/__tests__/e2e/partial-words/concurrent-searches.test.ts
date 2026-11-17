import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { NarsilConfig } from '../../../types/config'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import { INDEX, registerWorkshopLanguage, workshopCorpus } from './corpus'
import {
  expectSameHits,
  hitsOf,
  insertAll,
  NO_WORKERS,
  probeQueries,
  RESULT_LIMIT,
  startWorkshopServer,
  WORKERS_BUILT,
  WORKSHOP_INDEX_CONFIG,
  type WorkshopServer,
  waitForWorkerCopies,
  workerCopies,
} from './harness'
import { createOracle, type Oracle, type OracleQuery } from './oracle'

const SMALL_INDEX = 'workshop-small'
const LARGE_CORPUS_SIZE = 1_500
const SMALL_CORPUS_SIZE = 120
const GROWING_ADDITIONS = 90
const SEARCHES_IN_FLIGHT = 128
const CONCURRENT_SEARCHES_TEST_TIMEOUT_MS = 60_000

interface IndexedCorpus {
  index: string
  documents: AnyDocument[]
}

interface ConcurrentSearch {
  index: string
  query: OracleQuery
  includeScoreComponents: boolean
}

const servers: WorkshopServer[] = []
const directories: string[] = []

beforeAll(() => {
  registerWorkshopLanguage()
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function started(config: NarsilConfig): Promise<WorkshopServer> {
  const server = await startWorkshopServer(config)
  servers.push(server)
  return server
}

async function stopped(server: WorkshopServer): Promise<void> {
  servers.splice(servers.indexOf(server), 1)
  await server.stop()
}

async function createCorpus(server: WorkshopServer, index: string, documents: AnyDocument[]): Promise<void> {
  await server.client.createIndex(index, WORKSHOP_INDEX_CONFIG)
  const inserted = await server.client.insertBatch(index, documents)
  expect(inserted.failed).toEqual([])
}

function searchesOver(corpora: readonly IndexedCorpus[]): ConcurrentSearch[] {
  const searches: ConcurrentSearch[] = []
  for (const query of probeQueries()) {
    for (const { index } of corpora) {
      searches.push({ index, query, includeScoreComponents: false })
      searches.push({ index, query, includeScoreComponents: true })
    }
  }
  return searches.reverse()
}

async function expectEveryConcurrentSearch(server: WorkshopServer, corpora: readonly IndexedCorpus[]): Promise<void> {
  const oracles = new Map<string, Oracle>(corpora.map(corpus => [corpus.index, createOracle(corpus.documents)]))
  const searches = searchesOver(corpora)
  let checked = 0
  for (let start = 0; start < searches.length; start += SEARCHES_IN_FLIGHT) {
    const wave = searches.slice(start, start + SEARCHES_IN_FLIGHT)
    const answers = await Promise.all(
      wave.map(({ index, query, includeScoreComponents }) =>
        server.client.query(index, { ...query, includeScoreComponents, limit: RESULT_LIMIT } as QueryParams),
      ),
    )
    for (const [at, { index, query, includeScoreComponents }] of wave.entries()) {
      const oracle = oracles.get(index)
      if (oracle === undefined) throw new Error(`no oracle for ${index}`)
      const label = () => `${index} ${JSON.stringify(query)} includeScoreComponents=${includeScoreComponents}`
      expectSameHits(hitsOf(answers[at]), oracle.search(query), label)
      checked++
    }
  }
  expect(checked).toBe(searches.length)
}

describe('partial-word searches sent at once over HTTP each match the independent oracle', () => {
  it(
    'across a restarted durable index and a smaller growing one, on the main thread',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'narsil-concurrent-searches-'))
      directories.push(directory)
      const config: NarsilConfig = { durability: { directory }, workers: NO_WORKERS }
      const large: IndexedCorpus = { index: INDEX, documents: workshopCorpus(LARGE_CORPUS_SIZE, 67) }
      const small: IndexedCorpus = { index: SMALL_INDEX, documents: workshopCorpus(SMALL_CORPUS_SIZE, 71, 'small') }

      const writer = await started(config)
      await createCorpus(writer, large.index, large.documents)
      await createCorpus(writer, small.index, small.documents)
      await writer.engine.checkpoint(large.index)
      await writer.engine.checkpoint(small.index)
      await stopped(writer)

      const server = await started(config)
      const additions = workshopCorpus(GROWING_ADDITIONS, 73, 'grown')
      const added = await server.client.insertBatch(small.index, additions)
      expect(added.failed).toEqual([])
      small.documents = [...small.documents, ...additions]

      await expectEveryConcurrentSearch(server, [large, small])
    },
    CONCURRENT_SEARCHES_TEST_TIMEOUT_MS,
  )

  it.skipIf(!WORKERS_BUILT)(
    'across worker copies of the larger index and the main copy of the smaller one',
    async () => {
      const large: IndexedCorpus = { index: INDEX, documents: workshopCorpus(LARGE_CORPUS_SIZE, 79) }
      const small: IndexedCorpus = { index: SMALL_INDEX, documents: workshopCorpus(SMALL_CORPUS_SIZE, 83, 'small') }
      const server = await started({ workers: workerCopies() })
      await server.client.createIndex(large.index, WORKSHOP_INDEX_CONFIG)
      await insertAll(server, large.documents)
      await createCorpus(server, small.index, small.documents)
      await waitForWorkerCopies(server)

      await expectEveryConcurrentSearch(server, [large, small])
    },
    CONCURRENT_SEARCHES_TEST_TIMEOUT_MS,
  )
})
