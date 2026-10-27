import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { createNarsil, type Narsil } from '../../../narsil'
import { resetCheckpointWorkerLatch } from '../../../persistence/durability/checkpoint-worker-dispatch'
import type { StaleAnalysis } from '../../../types/config'
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
import { stripRecordedRevision } from './stored-metadata'

const SCHEMA = { title: 'string' as const }
const DOCUMENTS = 200

describe('a writer leaves the revision absent while it knows none for the terms', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-unknown-revision-'))
    resetCheckpointWorkerLatch()
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  async function writeWithoutRecordedRevision(corpus: OracleCorpus): Promise<void> {
    registerRevision(FIRST_REVISION)
    const random = seededRandom(17)
    const writer = await createNarsil({ durability: { directory: dir } })
    await writer.createIndex('prose', { schema: SCHEMA, language: LANGUAGE })
    const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
    await writer.insertBatch('prose', documents)
    for (const document of documents) corpus.write(document.id, document.title, FIRST_REVISION)
    await writer.checkpoint('prose')
    await writer.shutdown()
    await stripRecordedRevision(dir, 'prose')
    registerRevision(SECOND_REVISION)
  }

  async function writeWhileUnknown(opened: Narsil, corpus: OracleCorpus): Promise<void> {
    const random = seededRandom(19)
    for (let i = 0; i < 10; i++) {
      const title = sentence(random)
      await opened.insert('prose', { title }, `unknown-${i}`)
      corpus.write(`unknown-${i}`, title, SECOND_REVISION)
    }
  }

  async function openReporting(reported: StaleAnalysis[]): Promise<Narsil> {
    return createNarsil({
      durability: { directory: dir },
      analysis: { rebuild: 'manual', onStaleAnalysis: index => void reported.push(index) },
    })
  }

  it('keeps the metadata and the checkpoint free of a revision across restarts until the rebuild', async () => {
    const corpus = new OracleCorpus()
    await writeWithoutRecordedRevision(corpus)

    engine = await createNarsil({ durability: { directory: dir }, analysis: { rebuild: 'manual' } })
    await writeWhileUnknown(engine, corpus)
    await engine.checkpoint('prose')
    await engine.shutdown()

    const reported: StaleAnalysis[] = []
    engine = await openReporting(reported)
    expect(reported.map(index => index.storedRevision)).toEqual([null])
    await expectAnswersFrom(engine, corpus, 'old')

    await engine.rebuildAnalysis('prose')
    await engine.shutdown()
    const afterRebuild: StaleAnalysis[] = []
    engine = await openReporting(afterRebuild)
    expect(afterRebuild).toEqual([])
    await expectAnswersFrom(engine, corpus, 'new')
  })

  it('takes no revision into a snapshot of an index that records none', async () => {
    const corpus = new OracleCorpus()
    await writeWithoutRecordedRevision(corpus)
    engine = await createNarsil({ durability: { directory: dir }, analysis: { rebuild: 'manual' } })
    const bytes = await bytesOf(await engine.snapshot('prose'))
    await engine.shutdown()

    engine = await createNarsil({ analysis: { rebuild: 'manual' } })
    await engine.restore('prose', bytes)

    expect(engine.listIndexes()[0].analysisStale).toBe(true)
    await expectAnswersFrom(engine, corpus, 'old')
  })

  it('takes no revision into the partition archive of an index that records none', async () => {
    const corpus = new OracleCorpus()
    await writeWithoutRecordedRevision(corpus)
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
