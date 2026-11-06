import { ErrorCodes, NarsilError } from '../../../errors'
import type { HistoryFiles } from '../../../query-suggestions/history-files'
import type { StateChange, SuggestionsHost } from '../../../query-suggestions/host'
import { SUGGESTIONS_SCHEMA } from '../../../query-suggestions/local-host'
import type { Narsil } from '../../../types/engine'
import type { NarsilEventMap } from '../../../types/events'
import type { StoredQuerySuggestions } from '../../../types/internal'
import type { QuerySuggestionsSource } from '../../../types/query-suggestions'
import type { IndexConfig } from '../../../types/schema'
import { indexConfigKey, readIndexMetadataSnapshot } from '../../cluster/index-metadata'
import { metadataWithSuggestionState, suggestionStateOfSettings } from '../../cluster/query-suggestion-settings'
import { MAX_SETTINGS_REPLACEMENT_ATTEMPTS, SETTINGS_CONTENTION_REASON } from '../constants'
import type { ClusterNodeConfig, CreateIndexOptions } from '../types'
import { readClusterBuildRecord, writeClusterBuildRecord } from './build-records'
import { remoteHistoryOf } from './remote-history'
import type { ClusterSuggestionView } from './view'

export interface ClusterHostDeps {
  config: ClusterNodeConfig
  nodeId: string
  files: HistoryFiles
  view: ClusterSuggestionView
  engine: Narsil
  createMarkedIndex(
    name: string,
    config: IndexConfig,
    options: CreateIndexOptions,
    source: QuerySuggestionsSource,
  ): Promise<void>
  isController(): boolean
  emit<E extends keyof NarsilEventMap>(name: E, payload: NarsilEventMap[E]): number
}

function indexNotFound(indexName: string): NarsilError {
  return new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' does not exist in the cluster`, {
    indexName,
  })
}

async function updateClusterState(
  deps: ClusterHostDeps,
  indexName: string,
  change: StateChange,
): Promise<StoredQuerySuggestions | null> {
  const { coordinator } = deps.config
  for (let attempt = 1; attempt <= MAX_SETTINGS_REPLACEMENT_ATTEMPTS; attempt++) {
    const current = await readIndexMetadataSnapshot(coordinator, indexName)
    if (current === null) throw indexNotFound(indexName)
    await deps.view.refresh(indexName)
    const next = change(suggestionStateOfSettings(current.settings))
    if (
      await coordinator.compareAndSet(
        indexConfigKey(indexName),
        current.bytes,
        metadataWithSuggestionState(current, next),
      )
    ) {
      await deps.view.refresh(indexName)
      return next
    }
  }
  throw new NarsilError(
    ErrorCodes.CLUSTER_WRITE_BLOCKED,
    `Index '${indexName}' kept changing while its query suggestion settings were replaced ${MAX_SETTINGS_REPLACEMENT_ATTEMPTS} times over, so nothing was stored. Retry the request`,
    { reason: SETTINGS_CONTENTION_REASON, indexName, attempts: MAX_SETTINGS_REPLACEMENT_ATTEMPTS },
  )
}

async function createSuggestionsIndex(
  deps: ClusterHostDeps,
  name: string,
  source: QuerySuggestionsSource,
  language: string,
): Promise<void> {
  const sourceIndex = deps.view.get(source.index)
  if (sourceIndex === null) throw indexNotFound(source.index)
  const config: IndexConfig = { schema: { ...SUGGESTIONS_SCHEMA }, language, stopWords: new Set<string>() }
  try {
    await deps.createMarkedIndex(
      name,
      config,
      { partitionCount: 1, replicationFactor: sourceIndex.replicationFactor },
      source,
    )
  } catch (error) {
    if (!(error instanceof NarsilError && error.code === ErrorCodes.INDEX_ALREADY_EXISTS)) throw error
    const existing = await deps.view.refresh(name)
    const marker = existing?.state?.querySuggestionsSource
    if (marker?.index !== source.index || marker.group !== source.group) throw error
    return
  }
  await deps.view.refresh(name)
}

export function createClusterHost(deps: ClusterHostDeps): SuggestionsHost {
  const { coordinator } = deps.config
  return {
    engine: deps.engine,
    nodeId: deps.nodeId,
    files: deps.files,
    clustered: true,
    view: indexName => deps.view.get(indexName),
    indexNames: () => deps.view.names(),
    updateState: (indexName, change) => updateClusterState(deps, indexName, change),
    createSuggestionsIndex: (name, source, language) => createSuggestionsIndex(deps, name, source, language),
    remoteHistory: indexName =>
      remoteHistoryOf({ config: deps.config, nodeId: deps.nodeId, files: deps.files }, indexName),
    readBuildRecord: indexName => readClusterBuildRecord(coordinator, indexName),
    writeBuildRecord: (indexName, record) => writeClusterBuildRecord(coordinator, indexName, record),
    mayBuild: () => deps.isController(),
    emit<E extends keyof NarsilEventMap>(name: E, payload: NarsilEventMap[E]): void {
      if (deps.emit(name, payload) > 0 || name !== 'querySuggestionsWarning') return
      console.warn('Popular query suggestions warning:', payload)
    },
  }
}
