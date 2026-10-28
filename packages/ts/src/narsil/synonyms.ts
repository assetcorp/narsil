import { prepareSynonyms, raiseConfigInvalid, storedSynonymRules } from '../core/synonyms/stored'
import type { EngineCore } from '../engine/core'
import { synonymAnalysisOf } from '../engine/synonym-sets'
import type { SynonymOperations } from '../types/synonym-operations'
import type { SynonymRule } from '../types/synonyms'

const replacingByCore = new WeakMap<EngineCore, Map<string, Promise<unknown>>>()

async function withOpenIndex<T>(core: EngineCore, indexName: string, action: () => Promise<T>): Promise<T> {
  core.guardShutdown()
  core.requireIndex(indexName)
  const release = await core.indexState.acquire(indexName)
  try {
    return await action()
  } finally {
    release()
  }
}

async function oneAtATime<T>(core: EngineCore, indexName: string, action: () => Promise<T>): Promise<T> {
  let replacing = replacingByCore.get(core)
  if (replacing === undefined) {
    replacing = new Map()
    replacingByCore.set(core, replacing)
  }
  const chains = replacing
  const earlier = chains.get(indexName) ?? Promise.resolve()
  const current = earlier.catch(() => undefined).then(action)
  chains.set(indexName, current)
  try {
    return await current
  } finally {
    if (chains.get(indexName) === current) chains.delete(indexName)
  }
}

async function replace(core: EngineCore, indexName: string, synonyms: unknown, strictWords: boolean): Promise<void> {
  const entry = core.requireIndex(indexName)
  const manager = core.requireManager(indexName)
  const analysis = synonymAnalysisOf(entry.config, entry.language)
  const prepared = prepareSynonyms(synonyms, analysis, raiseConfigInvalid, strictWords)
  const previous = entry.synonyms
  entry.synonyms = prepared?.encoded ?? null
  try {
    if (core.durability) await core.durability.manager.persistMetadata(indexName)
  } catch (err) {
    entry.synonyms = previous
    throw err
  }
  manager.replaceSynonyms(prepared?.lookup ?? null)
  await core.orchestrator.replicateToWorkers({
    type: 'replaceSynonyms',
    indexName,
    requestId: `replace-synonyms-${indexName}`,
    ...(prepared !== null ? { synonyms: prepared.encoded } : {}),
  })
  await core.orchestrator.awaitWrites(indexName)
}

export function synonymOperations(core: EngineCore): SynonymOperations {
  return {
    updateSynonyms(indexName: string, synonyms: SynonymRule[]): Promise<void> {
      return withOpenIndex(core, indexName, () =>
        oneAtATime(core, indexName, () => replace(core, indexName, synonyms, true)),
      )
    },

    getSynonyms(indexName: string): Promise<SynonymRule[]> {
      return withOpenIndex(core, indexName, async () => storedSynonymRules(core.requireIndex(indexName).synonyms))
    },
  }
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
      await replace(core, indexName, rules, false)
      return true
    }),
  )
}
