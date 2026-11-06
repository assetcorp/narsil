import type { IndexView } from '../../../query-suggestions/host'
import type { StoredQuerySuggestions } from '../../../types/internal'
import { readIndexMetadataSnapshot } from '../../cluster/index-metadata'
import { suggestionStateOfSettings } from '../../cluster/query-suggestion-settings'
import { isHiddenGeneration } from '../../cluster/rebalance/records'
import type { ClusterCoordinator } from '../../coordinator/types'

export interface ClusterSuggestionIndex extends IndexView {
  replicationFactor: number
}

export interface SuggestionViewEvents {
  onGone(indexName: string): void
  onSettingChanged(
    indexName: string,
    previous: StoredQuerySuggestions | null,
    next: StoredQuerySuggestions | null,
  ): void
}

export interface ClusterSuggestionView {
  get(indexName: string): ClusterSuggestionIndex | null
  names(): string[]
  refresh(indexName: string): Promise<ClusterSuggestionIndex | null>
  start(): Promise<void>
  stop(): void
}

async function readIndex(coordinator: ClusterCoordinator, indexName: string): Promise<ClusterSuggestionIndex | null> {
  const snapshot = await readIndexMetadataSnapshot(coordinator, indexName)
  if (snapshot === null) return null
  const schema = await coordinator.getSchema(indexName)
  if (schema === null) return null
  return {
    state: suggestionStateOfSettings(snapshot.settings),
    schema,
    language: snapshot.settings?.language ?? 'english',
    indexUuid: snapshot.record.indexUuid,
    hasSync: snapshot.settings?.sync?.enabled === true,
    replicationFactor: snapshot.record.replicationFactor,
  }
}

export function createClusterSuggestionView(
  coordinator: ClusterCoordinator,
  events: SuggestionViewEvents,
  onError: (error: unknown) => void,
): ClusterSuggestionView {
  const held = new Map<string, ClusterSuggestionIndex>()
  const refreshing = new Map<string, Promise<ClusterSuggestionIndex | null>>()
  const again = new Set<string>()
  const unwatchers: Array<() => void> = []
  let stopped = true

  async function reread(indexName: string): Promise<ClusterSuggestionIndex | null> {
    const previous = held.get(indexName) ?? null
    const next = await readIndex(coordinator, indexName)
    if (stopped) return next
    if (next === null) {
      held.delete(indexName)
      if (previous !== null) events.onGone(indexName)
      return null
    }
    held.set(indexName, next)
    if (JSON.stringify(previous?.state ?? null) !== JSON.stringify(next.state)) {
      events.onSettingChanged(indexName, previous?.state ?? null, next.state)
    }
    return next
  }

  function refresh(indexName: string): Promise<ClusterSuggestionIndex | null> {
    if (isHiddenGeneration(indexName)) return Promise.resolve(null)
    const running = refreshing.get(indexName)
    if (running !== undefined) {
      again.add(indexName)
      return running
    }
    const run = (async () => {
      let latest: ClusterSuggestionIndex | null
      do {
        again.delete(indexName)
        latest = await reread(indexName)
      } while (again.has(indexName) && !stopped)
      return latest
    })().finally(() => refreshing.delete(indexName))
    refreshing.set(indexName, run)
    return run
  }

  function onChange(indexName: string): void {
    if (stopped || isHiddenGeneration(indexName)) return
    void refresh(indexName).catch(onError)
  }

  return {
    get: indexName => held.get(indexName) ?? null,
    names: () => [...held.keys()],
    refresh,
    async start() {
      if (!stopped) return
      stopped = false
      unwatchers.push(await coordinator.watchIndexMetadata(event => onChange(event.indexName)))
      unwatchers.push(await coordinator.watchSchemas(event => onChange(event.indexName)))
      for (const indexName of await coordinator.listSchemas()) {
        if (stopped) return
        if (!isHiddenGeneration(indexName)) await refresh(indexName).catch(onError)
      }
    },
    stop() {
      stopped = true
      for (const unwatch of unwatchers.splice(0)) unwatch()
      held.clear()
    },
  }
}
