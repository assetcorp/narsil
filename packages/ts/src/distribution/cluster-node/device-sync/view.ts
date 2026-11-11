import type { FeedChange } from '../../../sync/feed/source'
import { readIndexMetadataSnapshot, readIndexState } from '../../cluster/index-metadata'
import { isHiddenGeneration } from '../../cluster/rebalance/records'
import type { ClusterCoordinator } from '../../coordinator/types'
import type { ClusterLocalEngine } from '../local-engine'
import { DEVICE_SYNC_RECONCILE_INTERVAL_MS } from './constants'
import { changeBetween, feedSettingsOf, type HeldSyncIndex, syncStateOfSettings } from './state'

export interface DeviceSyncView {
  held(indexName: string): HeldSyncIndex | undefined
  current(indexName: string): Promise<HeldSyncIndex | null>
  refresh(indexName: string): Promise<HeldSyncIndex | null>
  listen(onChange: (change: FeedChange) => void): () => void
  start(): Promise<void>
  stop(): void
}

interface DeviceSyncViewDeps {
  coordinator: ClusterCoordinator
  engine: Pick<ClusterLocalEngine, 'listIndexes' | 'syncStateOf' | 'adoptSyncState'>
  onError(error: unknown): void
}

async function readHeld(coordinator: ClusterCoordinator, indexName: string): Promise<HeldSyncIndex | null> {
  const named = await readIndexMetadataSnapshot(coordinator, indexName)
  if (named === null) return null
  const servingName = (await coordinator.getAllocation(indexName))?.generation ?? indexName
  const state = await readIndexState(coordinator, servingName)
  if (state === null) return null
  const servingSettings = state.settings ?? named.settings
  const feedShape =
    servingName === indexName || servingSettings === undefined
      ? servingSettings
      : { ...servingSettings, bm25: named.settings?.bm25 }
  return {
    indexUuid: named.record.indexUuid,
    settings: named.settings,
    serving: { servingName, indexUuid: state.record.indexUuid, partitionCount: state.record.partitionCount },
    feedSettings: feedSettingsOf(feedShape, state.synonyms),
    synonymsGeneration: servingSettings?.synonyms?.generation ?? null,
  }
}

export function createDeviceSyncView(deps: DeviceSyncViewDeps): DeviceSyncView {
  const { coordinator, engine, onError } = deps
  const held = new Map<string, HeldSyncIndex>()
  const listeners = new Set<(change: FeedChange) => void>()
  const refreshing = new Map<string, Promise<HeldSyncIndex | null>>()
  const again = new Set<string>()
  const unwatchers: Array<() => void> = []
  let reconcileTimer: ReturnType<typeof setInterval> | null = null
  let reconciling = false
  let stopped = true

  function emit(change: FeedChange): void {
    for (const listener of listeners) {
      try {
        listener(change)
      } catch (error) {
        onError(error)
      }
    }
  }

  async function adoptOnLocalCopies(indexName: string, next: HeldSyncIndex | null): Promise<void> {
    const state = next === null ? null : syncStateOfSettings(next.settings)
    const local = new Set(engine.listIndexes().map(index => index.name))
    const servingName = next?.serving.servingName ?? indexName
    if (local.has(servingName)) await engine.adoptSyncState(servingName, state)
    if (servingName !== indexName && local.has(indexName)) await engine.adoptSyncState(indexName, null)
  }

  async function reread(indexName: string): Promise<HeldSyncIndex | null> {
    const previous = held.get(indexName)
    const next = await readHeld(coordinator, indexName)
    if (next === null) held.delete(indexName)
    else held.set(indexName, next)
    await adoptOnLocalCopies(indexName, next)
    const change = changeBetween(previous, next)
    if (change !== null) emit({ kind: change, indexName })
    return next
  }

  function refresh(indexName: string): Promise<HeldSyncIndex | null> {
    const running = refreshing.get(indexName)
    if (running !== undefined) {
      again.add(indexName)
      return running
    }
    const run = (async () => {
      let latest: HeldSyncIndex | null
      do {
        again.delete(indexName)
        latest = await reread(indexName)
      } while (again.has(indexName) && !stopped)
      return latest
    })().finally(() => refreshing.delete(indexName))
    refreshing.set(indexName, run)
    return run
  }

  function namesServedBy(changedName: string): string[] {
    if (!isHiddenGeneration(changedName)) return [changedName]
    const names: string[] = []
    for (const [indexName, index] of held) {
      if (index.serving.servingName === changedName) names.push(indexName)
    }
    return names
  }

  function onMetadataChange(changedName: string): void {
    for (const indexName of namesServedBy(changedName)) {
      void refresh(indexName).catch(onError)
    }
  }

  async function namesOfServedGenerations(): Promise<void> {
    const generations = engine
      .listIndexes()
      .map(index => index.name)
      .filter(name => isHiddenGeneration(name) && namesServedBy(name).length === 0)
    if (generations.length === 0) return
    const wanted = new Set(generations)
    for (const indexName of await coordinator.listSchemas()) {
      if (stopped || wanted.size === 0) return
      if (isHiddenGeneration(indexName) || held.has(indexName)) continue
      const generation = (await coordinator.getAllocation(indexName))?.generation
      if (generation === undefined || !wanted.has(generation)) continue
      wanted.delete(generation)
      await refresh(indexName).catch(onError)
    }
  }

  async function reconcile(): Promise<void> {
    if (reconciling || stopped) return
    reconciling = true
    try {
      for (const index of engine.listIndexes()) {
        if (stopped) return
        if (isHiddenGeneration(index.name)) continue
        const known = held.get(index.name)
        if (known === undefined) await refresh(index.name).catch(onError)
        else await adoptOnLocalCopies(index.name, known).catch(onError)
      }
      for (const [indexName, known] of held) {
        if (stopped) return
        if (known.serving.servingName !== indexName) await adoptOnLocalCopies(indexName, known).catch(onError)
      }
    } finally {
      reconciling = false
    }
  }

  return {
    held: indexName => held.get(indexName),
    async current(indexName) {
      return held.get(indexName) ?? refresh(indexName)
    },
    refresh,
    listen(onChange) {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    async start() {
      if (!stopped) return
      stopped = false
      unwatchers.push(await coordinator.watchIndexMetadata(event => onMetadataChange(event.indexName)))
      unwatchers.push(await coordinator.watchAllocation(event => onMetadataChange(event.indexName)))
      await namesOfServedGenerations().catch(onError)
      await reconcile().catch(onError)
      reconcileTimer = setInterval(() => void reconcile().catch(onError), DEVICE_SYNC_RECONCILE_INTERVAL_MS)
      reconcileTimer.unref?.()
    },
    stop() {
      stopped = true
      for (const unwatch of unwatchers.splice(0)) unwatch()
      if (reconcileTimer !== null) clearInterval(reconcileTimer)
      reconcileTimer = null
      held.clear()
      listeners.clear()
    },
  }
}
