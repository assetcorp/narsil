import type { EngineCore } from '../../engine/core'
import { publishedArchiveLayout } from '../../engine/sync/archive'
import { startSyncRetentionSweep } from '../../engine/sync/retention'
import { publishedSyncSnapshot } from '../../engine/sync/snapshot'
import { engineFeedSource } from '../../sync/feed/engine-source'
import type { Narsil } from '../../types/engine'
import type { SyncServing } from './serving'

export function engineSyncServing(engine: Narsil, core: EngineCore): SyncServing {
  startSyncRetentionSweep(core)
  return {
    async snapshot(indexName) {
      const published = await publishedSyncSnapshot(core, indexName)
      try {
        return {
          entityTag: published.snapshot.entityTag,
          layout: publishedArchiveLayout(indexName, published.snapshot, published.storage),
          release: published.unpin,
        }
      } catch (error) {
        published.unpin()
        throw error
      }
    },
    feed: engineFeedSource(engine, core),
    admitFeed: async () => undefined,
  }
}
