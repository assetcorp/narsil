import type { EngineCore, QuerySuggestionHooks } from '../engine/core'
import { dropEngineIndex } from '../engine/index-lifecycle'
import { emitWriteEventAfter } from '../engine/write-events'
import { ErrorCodes, NarsilError } from '../errors'
import type { NarsilConfig } from '../types/config'
import type { Narsil } from '../types/engine'
import { attachedRuntimeOf } from './attached'

function suggestionIndexesOf(core: EngineCore, sourceName: string): string[] {
  const names: string[] = []
  for (const [name, entry] of core.indexRegistry) {
    if (name !== sourceName && entry.querySuggestions?.querySuggestionsSource?.index === sourceName) names.push(name)
  }
  return names
}

export async function dropSuggestionIndexesOf(core: EngineCore, sourceName: string): Promise<void> {
  if (core.mutationCtx.capacityScope === 'partition') return
  for (const name of suggestionIndexesOf(core, sourceName)) {
    if (!core.indexRegistry.has(name)) continue
    await emitWriteEventAfter(core, name, dropEngineIndex(core, name))
  }
}

export async function clearLeftoversOfName(core: EngineCore, name: string): Promise<void> {
  if (core.mutationCtx.capacityScope === 'partition') return
  await dropSuggestionIndexesOf(core, name)
  await core.durability?.manager.removeQueryHistory?.(name)
}

function hooksOf(core: EngineCore): QuerySuggestionHooks {
  return {
    async beforeCreate(indexName) {
      await clearLeftoversOfName(core, indexName)
      if (core.indexRegistry.has(indexName)) {
        throw new NarsilError(ErrorCodes.INDEX_ALREADY_EXISTS, `Index "${indexName}" already exists`, { indexName })
      }
    },
    beforeDrop: indexName => dropSuggestionIndexesOf(core, indexName),
    async afterDrop(indexName) {
      await attachedRuntimeOf(core)?.onDrop(indexName)
    },
    async shutdown() {
      await attachedRuntimeOf(core)
        ?.stop()
        .catch(() => undefined)
    },
  }
}

export function installSuggestionHooks(core: EngineCore): void {
  core.querySuggestionHooks ??= hooksOf(core)
}

function holdsEnabledSetting(core: EngineCore): boolean {
  for (const entry of core.indexRegistry.values()) {
    if (entry.querySuggestions?.querySuggestions?.enabled === true) return true
  }
  return false
}

export async function startQuerySuggestions(
  core: EngineCore,
  engine: Narsil,
  config: NarsilConfig | undefined,
): Promise<void> {
  installSuggestionHooks(core)
  if (config?.querySuggestions === undefined && !holdsEnabledSetting(core)) return
  try {
    const { localRuntimeOf } = await import('./start')
    await localRuntimeOf(core, engine, config)
  } catch (error) {
    await engine.shutdown().catch(() => undefined)
    throw error
  }
}
