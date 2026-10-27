import { afterEach, describe, expect, it } from 'vitest'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { createNarsil, type Narsil } from '../../../narsil'
import { createMemoryPersistence } from '../../../persistence/memory'
import type { PersistenceAdapter } from '../../../types/adapters'
import type { StaleAnalysis } from '../../../types/config'
import { bytesOf } from '../../e2e/portability/archive-oracle'
import { expectAnswersFrom } from './answers'
import { gatedStore } from './gated-store'
import {
  FIRST_REVISION,
  LANGUAGE,
  OracleCorpus,
  registerRevision,
  SECOND_REVISION,
  seededRandom,
  sentence,
} from './oracle'

const SCHEMA = { title: 'string' as const }
const DOCUMENTS = 2_000

describe('a rebuild that a cluster replica overtakes with older terms', () => {
  let engine: Narsil | null = null

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
  })

  async function writeUnderFirstRevision(persistence: PersistenceAdapter, corpus: OracleCorpus | null): Promise<void> {
    const random = seededRandom(83)
    const writer = await createNarsil({ persistence, durability: { tier: 'snapshot' }, workers: { enabled: false } })
    await writer.createIndex('prose', { schema: SCHEMA, language: LANGUAGE })
    const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
    await writer.insertBatch('prose', documents)
    for (const document of documents) corpus?.write(document.id, document.title, FIRST_REVISION)
    await writer.checkpoint('prose')
    await writer.shutdown()
  }

  async function archiveUnderFirstRevision(): Promise<Uint8Array> {
    const persistence = createMemoryPersistence()
    await writeUnderFirstRevision(persistence, null)
    const sender = await createClusterLocalEngine({
      persistence,
      durability: { tier: 'snapshot' },
      workers: { enabled: false },
      analysis: { rebuild: 'manual' },
    })
    try {
      return await bytesOf((await sender.archiveReplicationPartition('prose', 0, () => 0)).stream)
    } finally {
      await sender.shutdown()
    }
  }

  it('keeps the index due a rebuild when a partition with older terms arrives while the rebuild checkpoints', async () => {
    const store = gatedStore()
    const corpus = new OracleCorpus()
    registerRevision(FIRST_REVISION)
    await writeUnderFirstRevision(store.adapter, corpus)
    const archived = await archiveUnderFirstRevision()
    registerRevision(SECOND_REVISION)

    const announced: { rebuild: (() => Promise<void>) | null } = { rebuild: null }
    const replica = await createClusterLocalEngine({
      persistence: store.adapter,
      durability: { tier: 'snapshot' },
      workers: { enabled: false },
      lifecycle: {},
      analysis: {
        rebuild: 'manual',
        onStaleAnalysis(_index, rebuild) {
          announced.rebuild = rebuild
        },
      },
    })
    try {
      await replica.open('prose')
      const rebuild = announced.rebuild
      if (rebuild === null) throw new Error('the replica announced no stale index')
      const checkpoint = store.holdNextSave()

      const rebuilding = rebuild()
      await checkpoint.started
      await replica.restoreReplicationPartition('prose', 0, archived, { schema: SCHEMA, language: LANGUAGE }, 1)
      checkpoint.release()
      await rebuilding

      await expectAnswersFrom(replica, corpus, 'old')
      await replica.checkpoint('prose')
    } finally {
      await replica.shutdown()
    }

    const reported: StaleAnalysis[] = []
    const reopened = await createNarsil({
      persistence: store.adapter,
      durability: { tier: 'snapshot' },
      workers: { enabled: false },
      analysis: { rebuild: 'manual', onStaleAnalysis: index => void reported.push(index) },
    })
    engine = reopened
    expect(reported.map(index => index.storedRevision)).toEqual([FIRST_REVISION])
  })
})
