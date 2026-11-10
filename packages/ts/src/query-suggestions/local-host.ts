import {
  buildRecordKey,
  createEngineIndex,
  emitEngineEvent,
  emitWriteEventAfter,
  historyFilesOf,
  oneSyncChangeAtATime,
  withOpenIndex,
} from '#platform/suggestions-host'
import type { EngineCore } from '../engine/core'
import type { NarsilConfig } from '../types/config'
import type { Narsil } from '../types/engine'
import type { NarsilEventMap } from '../types/events'
import type { StoredQuerySuggestions } from '../types/internal'
import type { QuerySuggestionsSource } from '../types/query-suggestions'
import { type BuildRecord, decodeBuildRecordFile, encodeBuildRecordFile } from './build-record'
import type { IndexView, RemoteFile, StateChange, SuggestionsHost } from './host'

export const SUGGESTIONS_SCHEMA = { query: 'string', count: 'number', origin: 'enum' } as const

async function* noRemoteHistory(): AsyncGenerator<RemoteFile> {}

function persistState(
  core: EngineCore,
  indexName: string,
  next: StoredQuerySuggestions | null,
): Promise<StoredQuerySuggestions | null> {
  const entry = core.requireIndex(indexName)
  const previous = entry.querySuggestions
  entry.querySuggestions = next
  const persisted = core.durability?.manager.persistMetadata(indexName) ?? Promise.resolve()
  return persisted.then(
    () => next,
    (error: unknown) => {
      if (core.indexRegistry.get(indexName) === entry) entry.querySuggestions = previous
      throw error
    },
  )
}

export function createLocalHost(core: EngineCore, engine: Narsil, config: NarsilConfig | undefined): SuggestionsHost {
  const files = historyFilesOf(core.durability?.manager.historyStorage?.() ?? null)
  return {
    engine,
    nodeId: '',
    files,
    clustered: false,

    view(indexName: string): IndexView | null {
      const entry = core.indexRegistry.get(indexName)
      if (entry === undefined) return null
      return {
        state: entry.querySuggestions,
        schema: entry.config.schema,
        language: entry.language.name,
        indexUuid: entry.indexUuid,
        hasSync: entry.sync !== null,
      }
    },

    indexNames: () => [...core.indexRegistry.keys()],

    updateState(indexName: string, change: StateChange): Promise<StoredQuerySuggestions | null> {
      return withOpenIndex(core, indexName, () =>
        oneSyncChangeAtATime(core.indexRegistry, indexName, () =>
          persistState(core, indexName, change(core.requireIndex(indexName).querySuggestions)),
        ),
      )
    },

    async createSuggestionsIndex(name: string, source: QuerySuggestionsSource, language: string): Promise<void> {
      const indexConfig = {
        schema: { ...SUGGESTIONS_SCHEMA },
        language,
        stopWords: new Set<string>(),
        partitions: { maxPartitions: 1 },
      }
      await emitWriteEventAfter(
        core,
        name,
        createEngineIndex(core, config, name, indexConfig, {
          appliesCreationLimits: true,
          querySuggestions: { querySuggestionsSource: source },
        }),
      )
    },

    remoteHistory: noRemoteHistory,

    async readBuildRecord(indexName: string): Promise<BuildRecord | null> {
      const bytes = await files.read(buildRecordKey(indexName))
      if (bytes === null || bytes === 'too-long') return null
      return decodeBuildRecordFile(bytes)
    },

    async writeBuildRecord(indexName: string, record: BuildRecord): Promise<void> {
      await files.write(buildRecordKey(indexName), encodeBuildRecordFile(record))
    },

    mayBuild: () => true,

    emit<E extends keyof NarsilEventMap>(name: E, payload: NarsilEventMap[E]): void {
      if (emitEngineEvent(core.eventHandlers, name, payload) > 0 || name !== 'querySuggestionsWarning') return
      console.warn('Popular query suggestions warning:', payload)
    },
  }
}
