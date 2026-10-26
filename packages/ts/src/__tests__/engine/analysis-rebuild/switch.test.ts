import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../../client'
import { createNarsil, type Narsil } from '../../../narsil'
import { resetCheckpointWorkerLatch } from '../../../persistence/durability/checkpoint-worker-dispatch'
import type { QueryResult } from '../../../types/results'
import { startTestServer } from '../../server/helpers'
import {
  FIRST_REVISION,
  LANGUAGE,
  OracleCorpus,
  PROBES,
  registerRevision,
  SECOND_REVISION,
  seededRandom,
  sentence,
} from './oracle'

const SCHEMA = { title: 'string' as const }
const DOCUMENTS = 3_000
const PARTITIONS = 4

interface Tally {
  old: number
  new: number
}

function expectOneRevision(corpus: OracleCorpus, probe: string, result: QueryResult, tally: Tally): void {
  const hits = result.hits.map(hit => hit.id)
  const states = corpus.statesMatching(probe, hits)
  const reported = result.analysisStale === true ? 'old' : 'new'
  expect({ probe, reported, states }).toEqual({ probe, reported, states: expect.arrayContaining([reported]) })
  tally[reported] += 1
}

describe('a rebuild switches every partition to the new terms at one point', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-analysis-switch-'))
    resetCheckpointWorkerLatch()
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  async function writeUnderFirstRevision(corpus: OracleCorpus): Promise<void> {
    registerRevision(FIRST_REVISION)
    const random = seededRandom(11)
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

  it('answers every search during the rebuild from one revision and keeps every write', async () => {
    const corpus = new OracleCorpus()
    await writeUnderFirstRevision(corpus)
    engine = await createNarsil({
      durability: { directory: dir },
      analysis: { rebuild: 'manual' },
      workers: { enabled: false },
    })
    const opened = engine
    const random = seededRandom(23)

    let finished = false
    const rebuilding = opened.rebuildAnalysis('prose').finally(() => {
      finished = true
    })
    const tally: Tally = { old: 0, new: 0 }
    let written = 0
    while (!finished) {
      for (const probe of PROBES) {
        expectOneRevision(corpus, probe, await opened.query('prose', { term: probe, limit: corpus.size }), tally)
      }
      const id = `doc-${Math.floor(random() * DOCUMENTS)}`
      const title = sentence(random)
      if (written % 3 === 0) {
        await opened.insert('prose', { title }, `during-${written}`)
        corpus.write(`during-${written}`, title, SECOND_REVISION)
      } else if (written % 3 === 1 && corpus.ids().includes(id)) {
        await opened.update('prose', id, { title })
        corpus.write(id, title, SECOND_REVISION)
      } else if (corpus.ids().includes(id)) {
        await opened.remove('prose', id)
        corpus.remove(id)
      }
      written += 1
    }
    await rebuilding

    expect(tally.old).toBeGreaterThan(0)
    for (const probe of PROBES) {
      const result = await opened.query('prose', { term: probe, limit: corpus.size })
      expect(result.analysisStale).toBeUndefined()
      expect(result.hits.map(hit => hit.id).sort()).toEqual(corpus.matches(probe, 'new'))
    }
    expect(await opened.countDocuments('prose')).toBe(corpus.size)
  }, 120_000)

  it('answers every search through the HTTP server from one revision while the rebuild runs as a task', async () => {
    const corpus = new OracleCorpus()
    await writeUnderFirstRevision(corpus)
    const server = await startTestServer(undefined, {
      durability: { directory: dir },
      analysis: { rebuild: 'manual' },
      workers: { enabled: false },
    })
    try {
      const client = createNarsilClient({ url: server.base })
      const random = seededRandom(31)
      const task = await client.rebuildAnalysis('prose')
      const tally: Tally = { old: 0, new: 0 }
      let written = 0
      let settled = false
      while (!settled) {
        for (const probe of PROBES) {
          expectOneRevision(corpus, probe, await client.query('prose', { term: probe, limit: corpus.size }), tally)
        }
        const title = sentence(random)
        await client.insert('prose', { title }, `http-${written}`)
        corpus.write(`http-${written}`, title, SECOND_REVISION)
        written += 1
        settled = (await client.getTask(task.id))?.status !== 'running'
      }
      expect((await client.waitForTask(task.id, { pollIntervalMs: 5 })).status).toBe('succeeded')
      expect(tally.old).toBeGreaterThan(0)
      for (const probe of PROBES) {
        const result = await client.query('prose', { term: probe, limit: corpus.size })
        expect(result.analysisStale).toBeUndefined()
        expect(result.hits.map(hit => hit.id).sort()).toEqual(corpus.matches(probe, 'new'))
      }
    } finally {
      await server.stop()
    }
  }, 120_000)

  it('keeps a large batch and a rebalance that arrive while the rebuild runs', async () => {
    const corpus = new OracleCorpus()
    await writeUnderFirstRevision(corpus)
    engine = await createNarsil({
      durability: { directory: dir },
      analysis: { rebuild: 'manual' },
      workers: { enabled: false },
    })
    const random = seededRandom(47)
    const batch = Array.from({ length: 500 }, (_, i) => ({ id: `batch-${i}`, title: sentence(random) }))

    const rebuilding = engine.rebuildAnalysis('prose')
    const inserted = await engine.insertBatch('prose', batch)
    for (const document of batch) corpus.write(document.id, document.title, SECOND_REVISION)
    await engine.rebalance('prose', 2)
    await rebuilding

    expect(inserted.failed).toEqual([])
    for (const probe of PROBES) {
      const result = await engine.query('prose', { term: probe, limit: corpus.size })
      expect(result.analysisStale).toBeUndefined()
      expect(result.hits.map(hit => hit.id).sort()).toEqual(corpus.matches(probe, 'new'))
    }
    expect(await engine.countDocuments('prose')).toBe(corpus.size)
  }, 120_000)

  it('finishes the rebuild before a drop that arrives while it runs and leaves a new index under that name current', async () => {
    const corpus = new OracleCorpus()
    await writeUnderFirstRevision(corpus)
    const opened = await createNarsil({
      durability: { directory: dir },
      analysis: { rebuild: 'manual' },
      workers: { enabled: false },
    })
    engine = opened
    const started = new Promise<void>(resolve => {
      opened.on('analysisRebuild', payload => {
        if (payload.status === 'started') resolve()
      })
    })

    const rebuilding = opened.rebuildAnalysis('prose')
    await started
    await opened.dropIndex('prose')
    await rebuilding
    await opened.createIndex('prose', { schema: SCHEMA, language: LANGUAGE })
    await opened.insert('prose', { title: 'jumping river' }, 'fresh')

    const result = await opened.query('prose', { term: 'jump' })
    expect(result.analysisStale).toBeUndefined()
    expect(result.hits.map(hit => hit.id)).toEqual(['fresh'])
    expect(opened.listIndexes()[0].analysisStale).toBeUndefined()
  }, 120_000)
})
