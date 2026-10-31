import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import type { BM25Params } from '../../../types/schema'
import { INDEX, registerGarageLanguage } from '../synonyms/corpus'
import type { GarageServer } from '../synonyms/harness'
import { garageConfig, startGarageServer, WORKERS_BUILT, waitForWorkerCopies, workerCopies } from '../synonyms/harness'
import { bm25Corpus, expectOracleScores, SETTINGS, searchWith, TITLE_HEAVY } from './harness'
import { createBm25Oracle } from './oracle'

const NO_WORKERS = { enabled: false }
const CORPUS_SIZE = 3_000

const servers: GarageServer[] = []
const directories: string[] = []

beforeAll(() => {
  registerGarageLanguage()
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function started(config: Parameters<typeof startGarageServer>[0]): Promise<GarageServer> {
  const server = await startGarageServer(config)
  servers.push(server)
  return server
}

async function tunedIndex(server: GarageServer, documents: ReturnType<typeof bm25Corpus>, bm25?: BM25Params) {
  await server.client.createIndex(INDEX, { ...garageConfig([]), ...(bm25 !== undefined ? { bm25 } : {}) })
  const inserted = await server.client.insertBatch(INDEX, documents)
  expect(inserted.failed).toEqual([])
  await server.client.waitForWrites(INDEX)
}

describe('every score matches an oracle that reads the documents', () => {
  it('through the API, the HTTP server, and the client, at every level and after each live change, with blocks skipped', async () => {
    const documents = bm25Corpus(CORPUS_SIZE, 981)
    const oracle = createBm25Oracle(documents)
    const server = await started({ workers: NO_WORKERS })
    await tunedIndex(server, documents, TITLE_HEAVY)
    await expectOracleScores(searchWith(server.client), oracle, TITLE_HEAVY, undefined, 'created')

    for (const setting of SETTINGS) {
      await server.client.updateBM25(INDEX, setting.index ?? {})
      await expectOracleScores(searchWith(server.engine), oracle, setting.index, setting.search, `API ${setting.label}`)
      await expectOracleScores(
        searchWith(server.client),
        oracle,
        setting.index,
        setting.search,
        `HTTP ${setting.label}`,
      )
    }
  }, 300_000)

  it('leaves a search that sets no pair on the defaults once a call clears the setting', async () => {
    const documents = bm25Corpus(800, 982)
    const oracle = createBm25Oracle(documents)
    const server = await started({ workers: NO_WORKERS })
    await tunedIndex(server, documents, TITLE_HEAVY)
    await server.engine.updateBM25(INDEX, { k1: 4 })
    await expectOracleScores(
      searchWith(server.engine),
      oracle,
      { k1: 4 },
      undefined,
      'replaced, so the fields are gone',
    )
    await server.engine.updateBM25(INDEX, {})
    await expectOracleScores(searchWith(server.engine), oracle, undefined, undefined, 'cleared')
  }, 120_000)

  it.skipIf(!WORKERS_BUILT)(
    'on worker copies, with the same pair on each copy for one search and after a live change',
    async () => {
      const documents = bm25Corpus(1_500, 983)
      const oracle = createBm25Oracle(documents)
      const server = await started({ workers: workerCopies() })
      await tunedIndex(server, documents.slice(0, 300), TITLE_HEAVY)
      await waitForWorkerCopies(server)
      const inserted = await server.client.insertBatch(INDEX, documents.slice(300))
      expect(inserted.failed).toEqual([])
      await server.client.waitForWrites(INDEX)
      await expectOracleScores(searchWith(server.client), oracle, TITLE_HEAVY, undefined, 'workers')
      const searchSetting = { k1: 0.8, fields: { body: { b: 0.1 } } }
      await expectOracleScores(searchWith(server.client), oracle, TITLE_HEAVY, searchSetting, 'workers, search pair')
      await server.client.updateBM25(INDEX, { b: 0.2 })
      await expectOracleScores(searchWith(server.client), oracle, { b: 0.2 }, undefined, 'workers, live change')
    },
    180_000,
  )

  it.skipIf(!WORKERS_BUILT)(
    'on a request thread, which holds its own copy of the setting',
    async () => {
      const documents = bm25Corpus(1_500, 984)
      const oracle = createBm25Oracle(documents)
      const { startTestServer, scaledOut, waitFor } = await import('../../server/helpers')
      const { createNarsilClient } = await import('../../../client')
      const server = await startTestServer(undefined, { workers: workerCopies() })
      try {
        const client = createNarsilClient({ url: server.base })
        await client.createIndex(INDEX, { ...garageConfig([]), bm25: TITLE_HEAVY })
        const inserted = await client.insertBatch(INDEX, documents)
        expect(inserted.failed).toEqual([])
        await waitFor(() => scaledOut(server.engine, INDEX))
        await client.waitForWrites(INDEX)
        await client.updateBM25(INDEX, { k1: 2.5, fields: { body: { k1: 0.25 } } })
        await expectOracleScores(
          searchWith(client),
          oracle,
          { k1: 2.5, fields: { body: { k1: 0.25 } } },
          undefined,
          'request thread',
        )
      } finally {
        await server.stop()
      }
    },
    180_000,
  )
})

describe('a live change beside the rest of the index', () => {
  it('leaves another index built from one config object alone, and a later partition limit still holds', async () => {
    const documents = bm25Corpus(300, 990)
    const oracle = createBm25Oracle(documents)
    const server = await started({ workers: NO_WORKERS })
    const shared = { ...garageConfig([]), partitions: undefined }
    await server.engine.createIndex(INDEX, shared)
    await server.engine.createIndex('other', shared)
    expect((await server.engine.insertBatch(INDEX, documents)).failed).toEqual([])
    expect((await server.engine.insertBatch('other', documents)).failed).toEqual([])

    await server.engine.updateBM25('other', { k1: 9 })
    await expectOracleScores(searchWith(server.engine), oracle, undefined, undefined, 'untouched index')

    await server.engine.updatePartitionConfig('other', { maxDocsPerPartition: documents.length })
    await expect(server.engine.insert('other', { title: 'road', body: 'river' })).rejects.toMatchObject({
      code: 'PARTITION_CAPACITY_EXCEEDED',
    })
  }, 60_000)
})

describe('the setting after the index leaves the server that built it', () => {
  it('keeps a live change across a restart, from the checkpoint and from the log, and through a synonym replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-bm25-'))
    directories.push(directory)
    const documents = bm25Corpus(1_200, 985)
    const first = await startGarageServer({ workers: NO_WORKERS, durability: { directory } })
    await tunedIndex(first, documents, { k1: 3 })
    await first.client.checkpoint(INDEX)
    await first.client.updateBM25(INDEX, TITLE_HEAVY)
    const late = bm25Corpus(200, 986, 'logged')
    expect((await first.client.insertBatch(INDEX, late)).failed).toEqual([])
    await first.client.updateSynonyms(INDEX, [{ words: ['road', 'lane'] }])
    await first.client.updateSynonyms(INDEX, [])
    await first.stop()

    const second = await started({ workers: NO_WORKERS, durability: { directory } })
    const oracle = createBm25Oracle([...documents, ...late])
    await expectOracleScores(searchWith(second.client), oracle, TITLE_HEAVY, undefined, 'restarted')
  }, 180_000)

  it('carries the field pairs in a snapshot restored into another server', async () => {
    const documents = bm25Corpus(1_200, 987)
    const source = await started({ workers: NO_WORKERS })
    await tunedIndex(source, documents)
    await source.client.updateBM25(INDEX, TITLE_HEAVY)
    const snapshot = await source.client.snapshot(INDEX)

    const target = await started({ workers: NO_WORKERS })
    const task = await target.client.restore(INDEX, snapshot)
    expect((await target.client.waitForTask(task.id)).status).toBe('succeeded')
    await expectOracleScores(searchWith(target.client), createBm25Oracle(documents), TITLE_HEAVY, undefined, 'restored')
  }, 180_000)

  it('keeps loading and scoring an index that stores a k1 above the limit', async () => {
    const documents = bm25Corpus(800, 988)
    const stored = { k1: 5_000 }
    const engine = await createClusterLocalEngine({ workers: NO_WORKERS })
    try {
      await engine.createIndex(INDEX, { ...garageConfig([]), bm25: stored })
      expect((await engine.insertBatch(INDEX, documents)).failed).toEqual([])
      const snapshot = await engine.snapshot(INDEX)

      const target = await started({ workers: NO_WORKERS })
      const task = await target.client.restore(INDEX, snapshot)
      expect((await target.client.waitForTask(task.id)).status).toBe('succeeded')
      await expectOracleScores(searchWith(target.client), createBm25Oracle(documents), stored, undefined, 'stored k1')
      await expect(target.client.updateBM25(INDEX, stored)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    } finally {
      await engine.shutdown()
    }
  }, 120_000)
})

describe('a cursor across a change of the setting', () => {
  it('keeps paging after a live change, and pages only a search with the same pair', async () => {
    const documents = bm25Corpus(800, 989)
    const server = await started({ workers: NO_WORKERS })
    await tunedIndex(server, documents)

    const first = await server.client.query(INDEX, { term: 'road', limit: 5 })
    expect(first.cursor).toBeDefined()
    await server.client.updateBM25(INDEX, { k1: 3 })
    const second = await server.client.query(INDEX, { term: 'road', limit: 5, searchAfter: first.cursor })
    expect(second.hits).toHaveLength(5)
    await server.client.query(INDEX, { term: 'road', limit: 5, searchAfter: first.cursor, bm25: {} })
    await server.client.query(INDEX, {
      term: 'road',
      limit: 5,
      searchAfter: first.cursor,
      bm25: { fields: { title: {} } },
    })

    const tuned = await server.client.query(INDEX, { term: 'road', limit: 5, bm25: { b: 0.5 } })
    await server.client.query(INDEX, { term: 'road', limit: 5, searchAfter: tuned.cursor, bm25: { b: 0.5 } })
    await expect(
      server.client.query(INDEX, { term: 'road', limit: 5, searchAfter: tuned.cursor, bm25: { b: 0.6 } }),
    ).rejects.toMatchObject({ code: 'SEARCH_INVALID_CURSOR' })
    await expect(
      server.client.query(INDEX, { term: 'road', limit: 5, searchAfter: tuned.cursor }),
    ).rejects.toMatchObject({ code: 'SEARCH_INVALID_CURSOR' })
  }, 60_000)
})
