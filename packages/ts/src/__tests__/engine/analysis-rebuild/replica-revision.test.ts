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
  type Revision,
  registerRevision,
  SECOND_REVISION,
  seededRandom,
  sentence,
} from './oracle'
import { stripRecordedRevision } from './stored-metadata'

const SCHEMA = { title: 'string' as const }
const DOCUMENTS = 200

describe('a cluster replica records the revision that produced the partition it receives', () => {
  let senderDir: string
  let replicaDir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    senderDir = await mkdtemp(join(tmpdir(), 'narsil-replica-sender-'))
    replicaDir = await mkdtemp(join(tmpdir(), 'narsil-replica-'))
    resetCheckpointWorkerLatch()
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(senderDir, { recursive: true, force: true })
    await rm(replicaDir, { recursive: true, force: true })
  })

  async function archiveWrittenUnder(
    revision: Revision,
    corpus: OracleCorpus,
    recordsRevision: boolean,
  ): Promise<Uint8Array> {
    registerRevision(revision)
    const random = seededRandom(29)
    const writer = await createNarsil({ durability: { directory: senderDir } })
    await writer.createIndex('prose', { schema: SCHEMA, language: LANGUAGE })
    const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
    await writer.insertBatch('prose', documents)
    for (const document of documents) corpus.write(document.id, document.title, revision)
    await writer.checkpoint('prose')
    await writer.shutdown()
    if (!recordsRevision) await stripRecordedRevision(senderDir, 'prose')

    registerRevision(SECOND_REVISION)
    const sender = await createClusterLocalEngine({
      durability: { directory: senderDir },
      analysis: { rebuild: 'manual' },
    })
    try {
      return await bytesOf((await sender.archiveReplicationPartition('prose', 0, () => 0)).stream)
    } finally {
      await sender.shutdown()
    }
  }

  async function receiveCheckpointAndRestart(
    archived: Uint8Array,
    corpus: OracleCorpus,
    state: 'old' | 'new',
  ): Promise<StaleAnalysis[]> {
    const replica = await createClusterLocalEngine({
      durability: { directory: replicaDir },
      analysis: { rebuild: 'manual' },
    })
    try {
      await replica.restoreReplicationPartition('prose', 0, archived, { schema: SCHEMA, language: LANGUAGE }, 1)
      await expectAnswersFrom(replica, corpus, state)
      await replica.checkpoint('prose')
    } finally {
      await replica.shutdown()
    }
    const reported: StaleAnalysis[] = []
    engine = await createNarsil({
      durability: { directory: replicaDir },
      analysis: { rebuild: 'manual', onStaleAnalysis: index => void reported.push(index) },
    })
    return reported
  }

  it.each([
    ['the revision that the sender records', true, FIRST_REVISION],
    ['no revision where the sender records none', false, null],
  ])('keeps %s across a checkpoint and a restart', async (_recorded, recordsRevision, storedRevision) => {
    const corpus = new OracleCorpus()
    const archived = await archiveWrittenUnder(FIRST_REVISION, corpus, recordsRevision)

    const reported = await receiveCheckpointAndRestart(archived, corpus, 'old')

    expect(reported.map(index => index.storedRevision)).toEqual([storedRevision])
  })

  it('stays current when the partition it receives holds current terms', async () => {
    const corpus = new OracleCorpus()
    const archived = await archiveWrittenUnder(SECOND_REVISION, corpus, true)

    const reported = await receiveCheckpointAndRestart(archived, corpus, 'new')

    expect(reported).toEqual([])
  })
})
