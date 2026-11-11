import { join } from 'node:path'
import { followSourceChanges } from '../../../changes/follow'
import type { ChangeSource } from '../../../changes/source'
import type { ChangesServing } from '../../../server/changes/serving'
import type { SyncServing } from '../../../server/sync/serving'
import type { FeedSource } from '../../../sync/feed/source'
import type { BackupRequestDeps } from '../../backups/requests'
import { openBackupStore } from '../../backups/store'
import type { ClusterCoordinator } from '../../coordinator/types'
import type { ClusterLocalEngine } from '../local-engine'
import type { ClusterNodeConfig } from '../types'
import type { ClusterNodeChanges } from '../types/changes-settings'
import type { ClusterNodeSyncSettings } from '../types/sync-settings'
import type { WriteRoutingDeps } from '../write-routing'
import { createBackupCatalog } from './backup-catalog'
import { exportClusterDocuments } from './changes-export'
import { readClusterChanges, requireChangeCaptureNodes, updateClusterChanges } from './changes-settings'
import { createClusterChangeSource } from './changes-source'
import { createClusterFeedSource } from './feed-source'
import { readClusterSync, registeredNodesBelowDeviceSync, syncNotReady, updateClusterSync } from './settings'
import { type ClusterSnapshots, createClusterSnapshots } from './snapshots'
import { createSpoolCache } from './spool-cache'
import { createDeviceSyncView, type DeviceSyncView } from './view'

export interface ClusterDeviceSyncDeps {
  config: ClusterNodeConfig
  nodeId: string
  coordinator: ClusterCoordinator
  engine: ClusterLocalEngine
  writeDeps: WriteRoutingDeps
  refreshAllocation(indexName: string): Promise<unknown>
  spoolDirectory: string
  guard: () => void
  onError(error: unknown): void
}

type TrackOperation = <T>(indexName: string | null, action: () => Promise<T>) => Promise<T>

export interface ClusterDeviceSync {
  view: DeviceSyncView
  operations(track: TrackOperation): ClusterNodeSyncSettings & ClusterNodeChanges
  serving(): SyncServing
  changesServing(): ChangesServing
  start(): Promise<void>
  stop(): Promise<void>
}

export function createClusterDeviceSync(deps: ClusterDeviceSyncDeps): ClusterDeviceSync {
  const { config, coordinator, engine, onError, guard } = deps
  const view = createDeviceSyncView({ coordinator, engine, onError })
  const store = config.backups === undefined ? null : openBackupStore(config.backups)
  const settings = {
    coordinator,
    view,
    hasBackupStore: store !== null,
    hasDurability: () => engine.syncStorage() !== null,
  }
  const requests: BackupRequestDeps = { config, nodeId: deps.nodeId, guard, store }
  const spools = createSpoolCache(join(deps.spoolDirectory, 'device-sync'), guard)
  let snapshots: ClusterSnapshots | null = null
  let feed: FeedSource | null = null
  let changeSource: ChangeSource | null = null
  let serving: SyncServing | null = null

  function feedSource(): FeedSource {
    feed ??= createClusterFeedSource({
      nodeId: deps.nodeId,
      writeDeps: deps.writeDeps,
      config,
      coordinator,
      engine,
      view,
      refreshAllocation: deps.refreshAllocation,
      snapshotBytes: indexName => snapshots?.snapshotBytes(indexName) ?? Promise.resolve(0),
    })
    return feed
  }

  const catalog = createBackupCatalog({
    coordinator,
    requests,
    bounds: (indexName, partitionId) => feedSource().bounds(indexName, partitionId),
    onError,
  })

  function changesSource(): ChangeSource {
    changeSource ??= createClusterChangeSource({ feed: feedSource(), view, coordinator })
    return changeSource
  }

  async function admitChanges(indexName: string): Promise<void> {
    await requireChangeCaptureNodes(settings, indexName)
    await view.current(indexName)
  }

  async function* follow(indexName: string, options: Parameters<ClusterNodeChanges['followChanges']>[1]) {
    guard()
    await admitChanges(indexName)
    yield* followSourceChanges({ source: changesSource(), guard }, indexName, options)
  }

  return {
    view,
    operations: track => ({
      updateSync: (indexName, setting) => track(indexName, () => updateClusterSync(settings, indexName, setting)),
      getSync: indexName => track(indexName, () => readClusterSync(settings, indexName)),
      updateChanges: (indexName, setting) => track(indexName, () => updateClusterChanges(settings, indexName, setting)),
      getChanges: indexName => track(indexName, () => readClusterChanges(settings, indexName)),
      followChanges: (indexName, options) => follow(indexName, options),
      exportDocuments: indexName =>
        track(indexName, () => exportClusterDocuments({ view, store, catalog, spools }, indexName)),
    }),
    serving() {
      if (serving !== null) return serving
      const built = createClusterSnapshots({ settings, store, catalog, spools })
      snapshots = built
      serving = {
        snapshot: indexName => built.snapshot(indexName),
        feed: feedSource(),
        async admitFeed(indexName) {
          const olderNodes = registeredNodesBelowDeviceSync(await coordinator.listNodes())
          if (olderNodes.length > 0) throw syncNotReady('The cluster has', olderNodes, indexName)
          await view.current(indexName)
        },
      }
      return serving
    },
    changesServing: () => ({ source: changesSource(), admitFeed: admitChanges }),
    start: () => view.start(),
    async stop() {
      view.stop()
      await catalog.close()
      await spools.close()
    },
  }
}
