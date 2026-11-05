import { removeDocumentBatch } from '#platform/memory-guarded-writes'
import type { EngineCore, IndexRegistryEntry } from '../engine/core'
import { emitEngineEvent } from '../engine/events'
import type { RestoredHistorySink, RestoreSuggestionHooks } from '../engine/snapshot/restore-setup'
import { ErrorCodes, NarsilError } from '../errors'
import type { Narsil } from '../types/engine'
import type { QuerySuggestionsWarningEvent } from '../types/query-suggestions'
import { attachedRuntimeOf } from './attached'
import { unionOfBans } from './bans'
import { BUILD_WRITE_BATCH } from './constants'
import { clearLeftoversOfName, installSuggestionHooks } from './engine-hooks'
import { RestoredHistory } from './restored-history'
import { withState } from './stored-state'

function warn(core: EngineCore, event: QuerySuggestionsWarningEvent): void {
  if (emitEngineEvent(core.eventHandlers, 'querySuggestionsWarning', event) > 0) return
  console.warn('Popular query suggestions warning:', event)
}

function requireNoSyncConflict(indexName: string, entry: IndexRegistryEntry): void {
  if (entry.sync === null || entry.querySuggestions?.querySuggestions?.enabled !== true) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `Index "${indexName}" has device sync on, and the archive turns popular query suggestions on, which a synced index cannot hold`,
    { indexName },
  )
}

async function removeFromOthers(core: EngineCore, engine: Narsil, indexName: string, bans: readonly string[]) {
  for (const [name, other] of core.indexRegistry) {
    if (name === indexName || other.querySuggestions?.querySuggestionsSource?.index !== indexName) continue
    for (let start = 0; start < bans.length; start += BUILD_WRITE_BATCH) {
      const result = await engine.removeBatch(name, bans.slice(start, start + BUILD_WRITE_BATCH))
      const failure = result.failed.find(failed => failed.error.code !== ErrorCodes.DOC_NOT_FOUND)
      if (failure !== undefined) throw failure.error
    }
  }
}

async function removeFromRestored(core: EngineCore, indexName: string, bans: readonly string[]) {
  for (let start = 0; start < bans.length; start += BUILD_WRITE_BATCH) {
    const result = await removeDocumentBatch(core.mutationCtx, indexName, bans.slice(start, start + BUILD_WRITE_BATCH))
    const failure = result.failed.find(failed => failed.error.code !== ErrorCodes.DOC_NOT_FOUND)
    if (failure !== undefined) throw failure.error
  }
}

async function applyBans(core: EngineCore, engine: Narsil, indexName: string, entry: IndexRegistryEntry) {
  const bans = entry.querySuggestions?.bannedQueries ?? []
  if (bans.length > 0) await removeFromOthers(core, engine, indexName, bans)
  const marker = entry.querySuggestions?.querySuggestionsSource
  if (marker === undefined || marker.index === indexName) return
  const sourceBans = core.indexRegistry.get(marker.index)?.querySuggestions?.bannedQueries ?? []
  if (sourceBans.length > 0) await removeFromRestored(core, indexName, sourceBans)
}

export function restoreSuggestionHooksOf(core: EngineCore, engine: Narsil, indexName: string): RestoreSuggestionHooks {
  installSuggestionHooks(core)
  return {
    async historySink(restored): Promise<RestoredHistorySink | null> {
      return attachedRuntimeOf(core)?.restoredHistory(indexName, restored?.querySuggestions) ?? null
    },

    async beforeInstall(entry, previous) {
      requireNoSyncConflict(indexName, entry)
      const previousBans = previous?.querySuggestions?.bannedQueries ?? []
      if (previousBans.length > 0) {
        const restoredBans = entry.querySuggestions?.bannedQueries ?? []
        entry.querySuggestions = withState(entry.querySuggestions, {
          bannedQueries: unionOfBans(previousBans, restoredBans),
        })
      }
      if (previous === undefined) await clearLeftoversOfName(core, indexName)
    },

    async afterActivate(entry) {
      try {
        await applyBans(core, engine, indexName, entry)
      } catch (error) {
        warn(core, {
          indexName,
          reason: 'ban-removal-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },

    async afterInstall(entry, history) {
      const runtime = attachedRuntimeOf(core)
      const enabled = entry.querySuggestions?.querySuggestions?.enabled === true
      try {
        if (!enabled) {
          if (runtime !== undefined) await runtime.discardHistory(indexName)
          else await core.durability?.manager.removeQueryHistory?.(indexName)
        } else if (runtime === undefined || runtime.scrambler === null) {
          warn(core, { indexName, reason: 'no-key' })
        } else if (history instanceof RestoredHistory) {
          await history.commit()
        }
      } catch (error) {
        warn(core, {
          indexName,
          reason: 'save-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
      runtime?.settingChanged(indexName)
    },
  }
}
