import { compareCodePoints } from '../../../core/ordering'
import { ErrorCodes } from '../../../errors'
import { BUILD_WRITE_BATCH } from '../../../query-suggestions/constants'
import { type HistoryFiles, historyFileOf, listHistoryFolder } from '../../../query-suggestions/history-files'
import { RestoredHistory } from '../../../query-suggestions/restored-history'
import type { QuerySuggestionsRuntime } from '../../../query-suggestions/runtime'
import type { Narsil } from '../../../types/engine'
import type { ClusterQueryHistory, RestoredHistoryWriter } from '../../backups/query-history'
import type { ClusterNodeConfig } from '../types'
import { remoteHistoryOf } from './remote-history'
import type { ClusterSuggestionView } from './view'

export interface ClusterQueryHistoryDeps {
  config: ClusterNodeConfig
  nodeId: string
  files: HistoryFiles
  view: ClusterSuggestionView
  runtime(): QuerySuggestionsRuntime | null
  engine(): Narsil | null
  clearName(indexName: string): Promise<void>
}

async function removeSourceBans(engine: Narsil, indexName: string, bans: readonly string[]): Promise<void> {
  for (let start = 0; start < bans.length; start += BUILD_WRITE_BATCH) {
    const result = await engine.removeBatch(indexName, bans.slice(start, start + BUILD_WRITE_BATCH))
    const failure = result.failed.find(failed => failed.error.code !== ErrorCodes.DOC_NOT_FOUND)
    if (failure !== undefined) throw failure.error
  }
}

export function createClusterQueryHistory(deps: ClusterQueryHistoryDeps): ClusterQueryHistory {
  const { files, view } = deps

  async function eachLocalFile(indexName: string, visit: (bytes: Uint8Array) => Promise<void>): Promise<void> {
    await deps.runtime()?.saveDay(indexName)
    const keys = (await listHistoryFolder(files, indexName))
      .filter(key => historyFileOf(indexName, key) !== null)
      .sort(compareCodePoints)
    for (const key of keys) {
      const bytes = await files.read(key)
      if (bytes instanceof Uint8Array) await visit(bytes)
    }
  }

  return {
    async eachFile(indexName, visit) {
      await eachLocalFile(indexName, visit)
      for await (const file of remoteHistoryOf({ config: deps.config, nodeId: deps.nodeId, files }, indexName)) {
        if (file.kind === 'file') await visit(file.bytes)
      }
    },

    clearName: indexName => deps.clearName(indexName),

    async restoredSink(indexName): Promise<RestoredHistoryWriter | null> {
      const runtime = deps.runtime()
      const setting = (await view.refresh(indexName))?.state?.querySuggestions
      if (setting?.enabled !== true || runtime === null || runtime.scrambler === null) return null
      return new RestoredHistory(runtime, indexName, setting)
    },

    async afterRestore(indexName) {
      const runtime = deps.runtime()
      const engine = deps.engine()
      const marker = (await view.refresh(indexName))?.state?.querySuggestionsSource
      if (marker !== undefined && marker.index !== indexName && engine !== null) {
        const bans = (await view.refresh(marker.index))?.state?.bannedQueries ?? []
        try {
          await removeSourceBans(engine, indexName, bans)
        } catch (error) {
          runtime?.host.emit('querySuggestionsWarning', {
            indexName,
            reason: 'ban-removal-failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (runtime === null) return
      if (runtime.scrambler === null && view.get(indexName)?.state?.querySuggestions?.enabled === true) {
        runtime.host.emit('querySuggestionsWarning', { indexName, reason: 'no-key' })
      }
      runtime.settingChanged(indexName)
    },
  }
}
