import type { EngineCore } from '../../engine/core'
import type { SynonymRule } from '../../types/synonyms'
import { prepareSynonyms } from './prepare'

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
  let chains = replacingByCore.get(core)
  if (chains === undefined) {
    chains = new Map()
    replacingByCore.set(core, chains)
  }
  const replacing = chains
  const earlier = replacing.get(indexName) ?? Promise.resolve()
  const current = earlier.catch(() => undefined).then(action)
  replacing.set(indexName, current)
  try {
    return await current
  } finally {
    if (replacing.get(indexName) === current) replacing.delete(indexName)
  }
}

async function replaceNow(core: EngineCore, indexName: string, value: unknown, strictWords: boolean): Promise<void> {
  const entry = core.requireIndex(indexName)
  const manager = core.requireManager(indexName)
  const prepared = prepareSynonyms(value, entry.config, entry.language, strictWords)
  const previous = entry.synonyms
  entry.synonyms = prepared?.encoded ?? null
  try {
    if (core.durability) await core.durability.manager.persistMetadata(indexName)
  } catch (err) {
    entry.synonyms = previous
    throw err
  }
  manager.synonyms = prepared?.lookup ?? null
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
