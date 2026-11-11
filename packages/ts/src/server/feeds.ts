import { engineChangeSource } from '../changes/engine-source'
import { createChangesHub } from '../changes/hub'
import type { EngineCore } from '../engine/core'
import { listenForSyncChanges } from '../engine/sync-notify'
import type { Narsil } from '../narsil'
import { createFeedHub } from '../sync/feed/hub'
import { type ChangesServing, changesServingSourceOf } from './changes/serving'
import { refusedRegex } from './regex-policy'
import type { Authorizer } from './request'
import { engineSyncServing } from './sync/engine-serving'
import { createFeedHost, type FeedHost, type HostedFeed } from './sync/feed-host'
import type { FeedKind } from './sync/feed-messages'
import type { ResolvedFeedOptions } from './sync/options'
import { type SyncServing, syncServingSourceOf } from './sync/serving'

export interface FeedSettings {
  sync: ResolvedFeedOptions | null
  changes: ResolvedFeedOptions | null
  allowRegex: boolean
  authorize: Authorizer | undefined
}

export interface StartedFeeds {
  host: FeedHost
  syncServing: SyncServing | null
}

function syncServingOf(engine: Narsil, core: EngineCore | undefined): SyncServing | null {
  const ofNode = syncServingSourceOf(engine)
  if (ofNode !== undefined) return ofNode()
  return core === undefined ? null : engineSyncServing(engine, core)
}

function changesServingOf(engine: Narsil, core: EngineCore | undefined): ChangesServing | null {
  const ofNode = changesServingSourceOf(engine)
  if (ofNode !== undefined) return ofNode()
  if (core === undefined) return null
  return { source: engineChangeSource(core, listenForSyncChanges), admitFeed: async () => undefined }
}

function hostedSyncFeed(serving: SyncServing, options: ResolvedFeedOptions): HostedFeed {
  const hub = createFeedHub(serving.feed, {
    ...options,
    onError: error => console.warn('A device sync feed failed to read its index:', error),
  })
  return {
    async admit(indexName, expiresAt) {
      await serving.admitFeed(indexName)
      return hub.admit(indexName, expiresAt)
    },
    close: () => hub.close(),
  }
}

function hostedChangesFeed(serving: ChangesServing, options: ResolvedFeedOptions, allowRegex: boolean): HostedFeed {
  const hub = createChangesHub(serving.source, {
    ...options,
    refuseFilter: filter => refusedRegex(filter, allowRegex),
    onError: error => console.warn('A change feed failed to read its index:', error),
  })
  return {
    async admit(indexName, expiresAt) {
      await serving.admitFeed(indexName)
      return hub.admit(indexName, expiresAt)
    },
    close: () => hub.close(),
  }
}

export function startFeeds(engine: Narsil, core: EngineCore | undefined, settings: FeedSettings): StartedFeeds | null {
  const hosted: Partial<Record<FeedKind, HostedFeed>> = {}
  let syncServing: SyncServing | null = null
  if (settings.sync !== null) {
    syncServing = syncServingOf(engine, core)
    if (syncServing !== null) hosted.sync = hostedSyncFeed(syncServing, settings.sync)
  }
  if (settings.changes !== null) {
    const serving = changesServingOf(engine, core)
    if (serving !== null) hosted.changes = hostedChangesFeed(serving, settings.changes, settings.allowRegex)
  }
  if (hosted.sync === undefined && hosted.changes === undefined) return null
  return { host: createFeedHost(hosted, settings.authorize), syncServing }
}
