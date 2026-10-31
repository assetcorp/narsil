import type { EngineCore } from '../../engine/core'
import { oneAtATime, withOpenIndex } from '../../engine/serial-index-update'
import type { SynonymRule } from '../../types/synonyms'
import { prepareSynonyms } from './prepare'

async function replaceNow(core: EngineCore, indexName: string, value: unknown, strictWords: boolean): Promise<void> {
  const entry = core.requireIndex(indexName)
  const manager = core.requireManager(indexName)
  const prepared = prepareSynonyms(value, entry.config, entry.language, strictWords)
  if (entry.pendingAnalysis !== null) {
    const { targetOfPending } = await import('../../engine/analysis-change/settings')
    const target = targetOfPending(entry, entry.pendingAnalysis)
    prepareSynonyms(value, target.config, target.language, strictWords)
  }
  const preparedUnder = manager.analysis
  const previous = entry.synonyms
  entry.synonyms = prepared?.encoded ?? null
  try {
    if (core.durability) await core.durability.manager.persistMetadata(indexName)
  } catch (err) {
    entry.synonyms = previous
    throw err
  }
  const current =
    manager.analysis === preparedUnder ? prepared : prepareSynonyms(value, entry.config, entry.language, false)
  manager.synonyms = current?.lookup ?? null
  await core.orchestrator.replicateToWorkers({
    type: 'replaceSynonyms',
    indexName,
    requestId: `replace-synonyms-${indexName}`,
    ...(prepared !== null ? { synonyms: prepared.encoded } : {}),
  })
  await core.orchestrator.awaitWrites(indexName)
}

export function replaceSynonymSet(
  core: EngineCore,
  indexName: string,
  value: unknown,
  strictWords: boolean,
): Promise<void> {
  return withOpenIndex(core, indexName, () =>
    oneAtATime(core, indexName, () => replaceNow(core, indexName, value, strictWords)),
  )
}

export function applyLoadedSynonyms(
  core: EngineCore,
  indexName: string,
  load: () => Promise<readonly SynonymRule[] | null>,
): Promise<boolean> {
  return withOpenIndex(core, indexName, () =>
    oneAtATime(core, indexName, async () => {
      const rules = await load()
      if (rules === null) return false
      await replaceNow(core, indexName, rules, false)
      return true
    }),
  )
}
