import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { resetCheckpointWorkerLatch } from '../../../persistence/durability/checkpoint-worker-dispatch'
import { bytesOf } from '../../e2e/portability/archive-oracle'
import { scaledOut, waitFor } from '../../server/helpers'
import { expectAnswersFrom } from './answers'
import {
  bootstrapSource,
  FIRST_REVISION,
  LANGUAGE,
  OracleCorpus,
  PROBES,
  registerRevision,
  SECOND_REVISION,
  seededRandom,
  sentence,
} from './oracle'

const distEntry = new URL('../../../../dist/workers/entry.mjs', import.meta.url)
const distPackage = new URL('../../../../dist/index.mjs', import.meta.url)
const built = existsSync(distEntry)

const SCHEMA = { title: 'string' as const }
const DOCUMENTS = 3_000
const PARTITIONS = 3
const STARTING_POOL_DOCUMENTS = 80_000
const STARTING_POOL_PARTITIONS = 8

describe.skipIf(!built)('a rebuild of an index with copies on worker threads', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-analysis-workers-'))
    resetCheckpointWorkerLatch()
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  async function writeUnderFirstRevision(corpus: OracleCorpus): Promise<void> {
    registerRevision(FIRST_REVISION)
    const random = seededRandom(41)
    const writer = await createNarsil({ durability: { directory: dir }, workers: { enabled: false } })
    await writer.createIndex('prose', { schema: SCHEMA, language: LANGUAGE })
    const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
    await writer.insertBatch('prose', documents)
    for (const document of documents) corpus.write(document.id, document.title, FIRST_REVISION)
    await writer.rebalance('prose', PARTITIONS)
    await writer.checkpoint('prose')
    await writer.shutdown()
    registerRevision(SECOND_REVISION)
  }

  async function openWithWorkers(promotionThreshold: number, durable = true): Promise<Narsil> {
    engine = await createNarsil({
      ...(durable ? { durability: { directory: dir } } : {}),
      analysis: { rebuild: 'manual' },
      workers: {
        enabled: true,
        count: 2,
        promotionThreshold,
        bootstrapModule: `data:text/javascript,${encodeURIComponent(bootstrapSource(distPackage.href, SECOND_REVISION))}`,
      },
    })
    return engine
  }

  async function expectNewAnswersEverywhere(opened: Narsil, corpus: OracleCorpus): Promise<void> {
    await waitFor(() => scaledOut(opened, 'prose'))
    for (let round = 0; round < 3; round++) await expectAnswersFrom(opened, corpus, 'new')
    expect(await opened.countDocuments('prose')).toBe(corpus.size)
  }

  async function snapshotUnderFirstRevision(
    corpus: OracleCorpus,
    random: () => number,
    count: number,
  ): Promise<Uint8Array> {
    registerRevision(FIRST_REVISION)
    const writer = await createNarsil({ workers: { enabled: false } })
    await writer.createIndex('prose', { schema: SCHEMA, language: LANGUAGE })
    const documents = Array.from({ length: count }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
    await writer.insertBatch('prose', documents)
    for (const document of documents) corpus.write(document.id, document.title, FIRST_REVISION)
    await writer.rebalance('prose', PARTITIONS)
    const snapshot = await bytesOf(await writer.snapshot('prose'))
    await writer.shutdown()
    registerRevision(SECOND_REVISION)
    return snapshot
  }

  async function restoreWithWorkersRunning(corpus: OracleCorpus, random: () => number): Promise<Narsil> {
    const snapshot = await snapshotUnderFirstRevision(corpus, random, DOCUMENTS)
    const opened = await openWithWorkers(DOCUMENTS + 200, false)
    await opened.createIndex('warm', { schema: SCHEMA, language: LANGUAGE })
    await opened.insertBatch(
      'warm',
      Array.from({ length: DOCUMENTS + 200 }, (_, i) => ({ id: `warm-${i}`, title: 'stone' })),
    )
    await waitFor(() => scaledOut(opened, 'warm'))
    await opened.restore('prose', snapshot)
    expect(opened.listIndexes().find(index => index.name === 'prose')?.analysisStale).toBe(true)
    return opened
  }

  it('keeps every document and serves the new terms when copies start loading during the rebuild', async () => {
    const corpus = new OracleCorpus()
    const random = seededRandom(43)
    const opened = await restoreWithWorkersRunning(corpus, random)
    const batch = Array.from({ length: 500 }, (_, i) => ({ id: `batch-${i}`, title: sentence(random) }))

    const rebuilding = opened.rebuildAnalysis('prose')
    const inserted = await opened.insertBatch('prose', batch, { wait: true })
    for (const document of batch) corpus.write(document.id, document.title, SECOND_REVISION)
    await rebuilding

    expect(inserted.failed).toEqual([])
    await expectNewAnswersEverywhere(opened, corpus)
  }, 120_000)

  it('promotes no copy that loaded the old terms when that load began before the rebuild', async () => {
    const corpus = new OracleCorpus()
    const random = seededRandom(53)
    const opened = await restoreWithWorkersRunning(corpus, random)
    const batch = Array.from({ length: 500 }, (_, i) => ({ id: `batch-${i}`, title: sentence(random) }))

    const inserting = opened.insertBatch('prose', batch, { wait: true })
    const rebuilding = opened.rebuildAnalysis('prose')
    const [inserted] = await Promise.all([inserting, rebuilding])
    for (const document of batch) corpus.write(document.id, document.title, SECOND_REVISION)

    expect(inserted.failed).toEqual([])
    await expectNewAnswersEverywhere(opened, corpus)
  }, 120_000)

  it('keeps every document when a copy load that waited on a starting worker pool freezes partitions during the rebuild', async () => {
    const corpus = new OracleCorpus()
    const random = seededRandom(59)
    const snapshot = await snapshotUnderFirstRevision(corpus, random, STARTING_POOL_DOCUMENTS)
    const opened = await openWithWorkers(STARTING_POOL_DOCUMENTS + 1, false)
    await opened.restore('prose', snapshot)
    await opened.rebalance('prose', STARTING_POOL_PARTITIONS)
    const title = sentence(random)
    await opened.insert('prose', { title }, 'threshold')
    corpus.write('threshold', title, SECOND_REVISION)

    await opened.query('prose', { term: 'warm' })
    await opened.rebuildAnalysis('prose')

    await expectNewAnswersEverywhere(opened, corpus)
  }, 120_000)

  it('answers every search from one revision on the main copy and on every worker copy', async () => {
    const corpus = new OracleCorpus()
    await writeUnderFirstRevision(corpus)
    const random = seededRandom(47)
    const opened = await openWithWorkers(100)
    await opened.query('prose', { term: 'warm' })
    await waitFor(() => scaledOut(opened, 'prose'))

    let finished = false
    const rebuilding = opened.rebuildAnalysis('prose').finally(() => {
      finished = true
    })
    let staleAnswers = 0
    let written = 0
    while (!finished) {
      const answers = await Promise.all(
        PROBES.map(probe => opened.query('prose', { term: probe, limit: corpus.size + 1 })),
      )
      answers.forEach((result, at) => {
        const reported = result.analysisStale === true ? 'old' : 'new'
        const states = corpus.statesMatching(
          PROBES[at],
          result.hits.map(hit => hit.id),
        )
        expect({ probe: PROBES[at], reported, states }).toEqual({
          probe: PROBES[at],
          reported,
          states: expect.arrayContaining([reported]),
        })
        if (reported === 'old') staleAnswers += 1
      })
      const title = sentence(random)
      await opened.insert('prose', { title }, `during-${written}`)
      corpus.write(`during-${written}`, title, SECOND_REVISION)
      written += 1
    }
    await rebuilding

    expect(staleAnswers).toBeGreaterThan(0)
    await expectNewAnswersEverywhere(opened, corpus)
  }, 120_000)
})
