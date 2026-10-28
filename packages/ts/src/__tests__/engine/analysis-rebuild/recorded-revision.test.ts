import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { createNarsil, type Narsil } from '../../../narsil'
import { resetCheckpointWorkerLatch } from '../../../persistence/durability/checkpoint-worker-dispatch'
import { createFilesystemPersistence } from '../../../persistence/filesystem'
import type { NarsilConfig, StaleAnalysis } from '../../../types/config'
import { bytesOf } from '../../e2e/portability/archive-oracle'
import { expectAnswersFrom } from './answers'
import {
  FIRST_REVISION,
  LANGUAGE,
  OracleCorpus,
  registerRevision,
  SECOND_REVISION,
  seededRandom,
  sentence,
} from './oracle'

vi.setConfig({ testTimeout: 20_000 })

const SCHEMA = { title: 'string' as const }
const DOCUMENTS = 200

describe('every checkpoint, snapshot, and archive records the revision that produced its terms', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-recorded-revision-'))
    resetCheckpointWorkerLatch()
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  async function writeUnderFirstRevision(config: NarsilConfig, corpus: OracleCorpus): Promise<void> {
    registerRevision(FIRST_REVISION)
    const random = seededRandom(5)
    const writer = await createNarsil(config)
    await writer.createIndex('prose', { schema: SCHEMA, language: LANGUAGE })
    const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
    await writer.insertBatch('prose', documents)
    for (const document of documents) corpus.write(document.id, document.title, FIRST_REVISION)
    await writer.checkpoint('prose')
    await writer.shutdown()
    registerRevision(SECOND_REVISION)
  }

  async function writeWhileDue(opened: Narsil, corpus: OracleCorpus): Promise<void> {
    const random = seededRandom(9)
    for (let i = 0; i < 20; i++) {
      const title = sentence(random)
      await opened.insert('prose', { title }, `due-${i}`)
      corpus.write(`due-${i}`, title, SECOND_REVISION)
    }
    await opened.update('prose', 'doc-0', { title: 'jumping river' })
    corpus.write('doc-0', 'jumping river', SECOND_REVISION)
    await opened.remove('prose', 'doc-1')
    corpus.remove('doc-1')
  }

  it.each([
    ['a filesystem checkpoint', (directory: string): NarsilConfig => ({ durability: { directory } })],
    [
      'a snapshot-tier checkpoint',
      (directory: string): NarsilConfig => ({
        persistence: createFilesystemPersistence({ directory }),
        durability: { tier: 'snapshot' },
      }),
    ],
  ])('keeps an index due its rebuild across a restart after %s', async (_tier, configFor) => {
    const corpus = new OracleCorpus()
    await writeUnderFirstRevision(configFor(dir), corpus)

    engine = await createNarsil({ ...configFor(dir), analysis: { rebuild: 'manual' } })
    await writeWhileDue(engine, corpus)
    await engine.checkpoint('prose')
    await engine.shutdown()

    const reported: StaleAnalysis[] = []
    engine = await createNarsil({
      ...configFor(dir),
      analysis: { rebuild: 'manual', onStaleAnalysis: index => void reported.push(index) },
    })

    expect(reported).toEqual([
      {
        indexName: 'prose',
        language: LANGUAGE,
        storedRevision: FIRST_REVISION,
        currentRevision: SECOND_REVISION,
        documentCount: corpus.size,
      },
    ])
    await expectAnswersFrom(engine, corpus, 'old')

    await engine.rebuildAnalysis('prose')
    await expectAnswersFrom(engine, corpus, 'new')
    await engine.shutdown()

    engine = await createNarsil({ ...configFor(dir), analysis: { rebuild: 'manual' } })
    expect(engine.listIndexes()[0].analysisStale).toBeUndefined()
    await expectAnswersFrom(engine, corpus, 'new')
  })

  it('restores a snapshot taken while the index is due its rebuild as due', async () => {
    const corpus = new OracleCorpus()
    await writeUnderFirstRevision({ durability: { directory: dir } }, corpus)
    engine = await createNarsil({ durability: { directory: dir }, analysis: { rebuild: 'manual' } })
    await writeWhileDue(engine, corpus)
    const bytes = await bytesOf(await engine.snapshot('prose'))
    await engine.shutdown()

    engine = await createNarsil({ analysis: { rebuild: 'manual' } })
    await engine.restore('prose', bytes)

    expect(engine.listIndexes()[0].analysisStale).toBe(true)
    await expectAnswersFrom(engine, corpus, 'old')
    await engine.rebuildAnalysis('prose')
    await expectAnswersFrom(engine, corpus, 'new')
  })

  it('restores a snapshot taken after the rebuild as current', async () => {
    const corpus = new OracleCorpus()
    await writeUnderFirstRevision({ durability: { directory: dir } }, corpus)
    engine = await createNarsil({ durability: { directory: dir }, analysis: { rebuild: 'manual' } })
    await engine.rebuildAnalysis('prose')
    const bytes = await bytesOf(await engine.snapshot('prose'))
    await engine.shutdown()

    engine = await createNarsil({ analysis: { rebuild: 'manual' } })
    await engine.restore('prose', bytes)

    expect(engine.listIndexes()[0].analysisStale).toBeUndefined()
    await expectAnswersFrom(engine, corpus, 'new')
  })

  it('records the stored revision in the partition archive a cluster node sends', async () => {
    const corpus = new OracleCorpus()
    await writeUnderFirstRevision({ durability: { directory: dir } }, corpus)
    const node = await createClusterLocalEngine({ durability: { directory: dir }, analysis: { rebuild: 'manual' } })
    let archived: Uint8Array
    try {
      archived = await bytesOf((await node.archiveReplicationPartition('prose', 0, () => 0)).stream)
    } finally {
      await node.shutdown()
    }

    engine = await createNarsil({ analysis: { rebuild: 'manual' } })
    await engine.restore('prose', archived)

    expect(engine.listIndexes()[0].analysisStale).toBe(true)
    await expectAnswersFrom(engine, corpus, 'old')
  })
})
