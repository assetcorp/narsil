import { createNarsil, type Narsil } from '../../../narsil'
import type { PersistenceAdapter } from '../../../types/adapters'
import {
  FIRST_REVISION,
  LANGUAGE,
  type OracleCorpus,
  registerRevision,
  SECOND_REVISION,
  seededRandom,
  sentence,
} from './oracle'

export const SCHEMA = { title: 'string' as const }
const DOCUMENTS = 2_000
const PARTITIONS = 4
const CORPUS_SEED = 71

export async function writeUnderFirstRevision(adapter: PersistenceAdapter, corpus: OracleCorpus): Promise<void> {
  registerRevision(FIRST_REVISION)
  const random = seededRandom(CORPUS_SEED)
  const writer = await createNarsil({
    persistence: adapter,
    durability: { tier: 'snapshot' },
    workers: { enabled: false },
  })
  await writer.createIndex('prose', { schema: SCHEMA, language: LANGUAGE, partitions: { maxPartitions: PARTITIONS } })
  const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
  await writer.insertBatch('prose', documents)
  for (const document of documents) corpus.write(document.id, document.title, FIRST_REVISION)
  await writer.rebalance('prose', PARTITIONS)
  await writer.checkpoint('prose')
  await writer.shutdown()
  registerRevision(SECOND_REVISION)
}

export async function openUnderSecondRevision(
  adapter: PersistenceAdapter,
  track: (engine: Narsil) => void,
): Promise<{ opened: Narsil; rebuild: (() => Promise<void>) | null }> {
  const announced: { rebuild: (() => Promise<void>) | null } = { rebuild: null }
  const opened = await createNarsil({
    persistence: adapter,
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
  track(opened)
  await opened.open('prose')
  return { opened, rebuild: announced.rebuild }
}
