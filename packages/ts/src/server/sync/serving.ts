import type { ArchiveLayout } from '../../persistence/archive/range-layout'
import type { FeedSource } from '../../sync/feed/source'

export interface SnapshotDownload {
  entityTag: string
  layout: ArchiveLayout
  release(): void
}

export interface SyncServing {
  snapshot(indexName: string): Promise<SnapshotDownload>
  feed: FeedSource
  admitFeed(indexName: string): Promise<void>
}

const syncServingSources = new WeakMap<object, () => SyncServing>()

export function bindSyncServing(owner: object, serving: () => SyncServing): void {
  syncServingSources.set(owner, serving)
}

export function syncServingSourceOf(owner: object): (() => SyncServing) | undefined {
  return syncServingSources.get(owner)
}
