import { attachedRuntimeOf, loadStorageCode } from '#platform/restore-queue-host'
import { abandonChangeOf } from '../engine/analysis-change-entry'
import type { EngineCore, IndexRegistryEntry } from '../engine/core'
import type { RestoreDeps } from '../engine/snapshot'
import type { RestoreSuggestionHooks } from '../engine/snapshot/restore-setup'
import { restoreSuggestionHooksOf } from '../query-suggestions/restore-hooks'

export { bindRestoreQueueHost, startQuerySuggestions } from '#platform/restore-queue-host'
export { abandonChangeOf, resumeChangeOf, resumeEveryChange } from '../engine/analysis-change-entry'

import type { ByteSource } from '../types/byte-source'
import type { Narsil } from '../types/engine'

export type RestoreHost = Pick<
  RestoreDeps,
  | 'getVectorFieldPaths'
  | 'announceIndexCreated'
  | 'announceIndexDropped'
  | 'defaultEmbeddingAdapter'
  | 'releaseTimeoutMs'
>

function suggestionsInPlay(core: EngineCore, ...entries: Array<IndexRegistryEntry | undefined>): boolean {
  return core.querySuggestionHooks !== undefined || entries.some(entry => (entry?.querySuggestions ?? null) !== null)
}

function suggestionHooksLoadedOnUse(core: EngineCore, engine: Narsil, indexName: string): RestoreSuggestionHooks {
  let loaded: Promise<RestoreSuggestionHooks> | null = null
  const load = (): Promise<RestoreSuggestionHooks> => {
    loaded ??= Promise.resolve(restoreSuggestionHooksOf(core, engine, indexName))
    return loaded
  }
  return {
    historySink: async restored =>
      attachedRuntimeOf(core)?.restoredHistory(indexName, restored?.querySuggestions) ?? null,
    async beforeInstall(entry, previous) {
      if (suggestionsInPlay(core, entry, previous)) await (await load()).beforeInstall(entry, previous)
    },
    async afterActivate(entry) {
      if (suggestionsInPlay(core, entry)) await (await load()).afterActivate(entry)
    },
    async afterInstall(entry, history) {
      if (suggestionsInPlay(core, entry) || history !== null) await (await load()).afterInstall(entry, history)
    },
  }
}

function restoreDepsOf(core: EngineCore, host: RestoreHost, engine: Narsil, indexName: string): RestoreDeps {
  return {
    ...host,
    querySuggestions: suggestionHooksLoadedOnUse(core, engine, indexName),
    executor: core.executor,
    indexRegistry: core.indexRegistry,
    durability: core.durability,
    filesystemDurability: core.filesystemDurability,
    embeddingAdapters: core.embeddingAdapters,
    markAnalysisStale: core.analysisRebuild.markStale,
    clearAnalysisStale: core.analysisRebuild.clearStale,
    abandonAnalysisRebuild: async indexName => {
      await core.analysisRebuild.abandon(indexName)
      await abandonChangeOf(core, indexName)
    },
    abandonAnalysisChange: indexName => abandonChangeOf(core, indexName),
    indexState: core.indexState,
    copies: core.orchestrator,
    forgetWatermark: core.watermarkNotifier.forget,
  }
}

export async function runRestore(
  core: EngineCore,
  host: RestoreHost,
  indexName: string,
  data: ByteSource,
  engine: Narsil,
): Promise<void> {
  const { restoreFromSnapshot } = await loadStorageCode()
  await restoreFromSnapshot(indexName, data, restoreDepsOf(core, host, engine, indexName))
}
