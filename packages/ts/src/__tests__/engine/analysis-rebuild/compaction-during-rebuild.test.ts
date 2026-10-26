import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { bytesOf } from '../../e2e/portability/archive-oracle'
import { scaledOut, waitFor } from '../../server/helpers'
import { expectAnswersFrom } from './answers'
import { type CompactionGate, compactionGate } from './compaction-gate'
import {
  bootstrapSource,
  FIRST_REVISION,
  LANGUAGE,
  OracleCorpus,
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
const BATCH_DOCUMENTS = 600

describe.skipIf(!built)('a rebuild that meets a segment compaction on a worker copy', () => {
  let dir: string
  let gate: CompactionGate
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-analysis-compaction-'))
    gate = compactionGate(dir)
  })

  afterEach(async () => {
    await gate.open()
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  async function snapshotUnderFirstRevision(corpus: OracleCorpus, random: () => number): Promise<Uint8Array> {
    registerRevision(FIRST_REVISION)
    const writer = await createNarsil({ workers: { enabled: false } })
    await writer.createIndex('prose', { schema: SCHEMA, language: LANGUAGE })
    const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
    await writer.insertBatch('prose', documents)
    for (const document of documents) corpus.write(document.id, document.title, FIRST_REVISION)
    await writer.rebalance('prose', PARTITIONS)
    const snapshot = await bytesOf(await writer.snapshot('prose'))
    await writer.shutdown()
    registerRevision(SECOND_REVISION)
    return snapshot
  }

  async function openWithGatedWorkers(): Promise<Narsil> {
    const source = `${bootstrapSource(distPackage.href, SECOND_REVISION)}\n${gate.source}`
    engine = await createNarsil({
      analysis: { rebuild: 'manual' },
      workers: {
        enabled: true,
        count: 2,
        promotionThreshold: DOCUMENTS,
        bootstrapModule: `data:text/javascript,${encodeURIComponent(source)}`,
      },
    })
    return engine
  }

  it('loads no segment that a compaction merged from the old terms into the copies that follow the rebuild', async () => {
    const corpus = new OracleCorpus()
    const random = seededRandom(61)
    const snapshot = await snapshotUnderFirstRevision(corpus, random)
    const opened = await openWithGatedWorkers()
    await opened.restore('prose', snapshot)
    await opened.query('prose', { term: 'warm' })
    await waitFor(() => scaledOut(opened, 'prose'))

    await gate.close()
    const batch = Array.from({ length: BATCH_DOCUMENTS }, (_, i) => ({ id: `batch-${i}`, title: sentence(random) }))
    await opened.insertBatch('prose', batch, { wait: true })
    for (const document of batch) corpus.write(document.id, document.title, SECOND_REVISION)
    await gate.awaitHeldCompaction()

    const rebuilding = opened.rebuildAnalysis('prose')
    await waitFor(async () => (await opened.query('prose', { term: 'jump' })).analysisStale === undefined)
    await gate.open()
    await rebuilding

    await waitFor(() => scaledOut(opened, 'prose'))
    for (let round = 0; round < 3; round++) await expectAnswersFrom(opened, corpus, 'new')
    expect(await opened.countDocuments('prose')).toBe(corpus.size)
  }, 120_000)
})
