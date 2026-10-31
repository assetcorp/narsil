import type { EngineCore } from './core'

const updatingByCore = new WeakMap<EngineCore, Map<string, Promise<unknown>>>()

export async function withOpenIndex<T>(core: EngineCore, indexName: string, action: () => Promise<T>): Promise<T> {
  core.guardShutdown()
  core.requireIndex(indexName)
  const release = await core.indexState.acquire(indexName)
  try {
    return await action()
  } finally {
    release()
  }
}

export async function oneAtATime<T>(core: EngineCore, indexName: string, action: () => Promise<T>): Promise<T> {
  let chains = updatingByCore.get(core)
  if (chains === undefined) {
    chains = new Map()
    updatingByCore.set(core, chains)
  }
  const updating = chains
  const earlier = updating.get(indexName) ?? Promise.resolve()
  const current = earlier.catch(() => undefined).then(action)
  updating.set(indexName, current)
  try {
    return await current
  } finally {
    if (updating.get(indexName) === current) updating.delete(indexName)
  }
}
