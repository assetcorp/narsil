import { join } from 'node:path'
import type { SyncServing } from '../../../server/sync/serving'
import type { SyncSetting, SyncStatus } from '../../../types/sync'
import type { BackupRequestDeps } from '../../backups/requests'
import { openBackupStore } from '../../backups/store'
import type { ClusterCoordinator } from '../../coordinator/types'
import type { ClusterLocalEngine } from '../local-engine'
import type { ClusterNodeConfig } from '../types'
import type { WriteRoutingDeps } from '../write-routing'
import { createClusterFeedSource } from './feed-source'
import { readClusterSync, registeredNodesBelowDeviceSync, syncNotReady, updateClusterSync } from './settings'
import { type ClusterSnapshots, createClusterSnapshots } from './snapshots'
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

export interface ClusterDeviceSync {
  view: DeviceSyncView
  updateSync(indexName: string, setting: SyncSetting): Promise<void>
  getSync(indexName: string): Promise<SyncStatus>
  serving(): SyncServing
  start(): Promise<void>
  stop(): Promise<void>
}

export function createClusterDeviceSync(deps: ClusterDeviceSyncDeps): ClusterDeviceSync {
  const { config, coordinator, engine, onError } = deps
  const view = createDeviceSyncView({ coordinator, engine, onError })
  const store = config.backups === undefined ? null : openBackupStore(config.backups)
  const settings = {
    coordinator,
    view,
    hasBackupStore: store !== null,
    hasDurability: () => engine.syncStorage() !== null,
  }
  const requests: BackupRequestDeps = { config, nodeId: deps.nodeId, guard: deps.guard, store }
  let snapshots: ClusterSnapshots | null = null
  let serving: SyncServing | null = null

  return {
    view,
    updateSync: (indexName, setting) => updateClusterSync(settings, indexName, setting),
    getSync: indexName => readClusterSync(settings, indexName),
    serving() {
      if (serving !== null) return serving
      const feed = createClusterFeedSource({
        nodeId: deps.nodeId,
        writeDeps: deps.writeDeps,
        config,
        coordinator,
        engine,
        view,
        refreshAllocation: deps.refreshAllocation,
        snapshotBytes: indexName => snapshots?.snapshotBytes(indexName) ?? Promise.resolve(0),
      })
      const built = createClusterSnapshots({
        coordinator,
        settings,
        store,
        requests,
        spoolDirectory: join(deps.spoolDirectory, 'device-sync'),
        bounds: (indexName, partitionId) => feed.bounds(indexName, partitionId),
        onError,
      })
      snapshots = built
      serving = {
        snapshot: indexName => built.snapshot(indexName),
        feed,
        async admitFeed(indexName) {
          const olderNodes = registeredNodesBelowDeviceSync(await coordinator.listNodes())
          if (olderNodes.length > 0) throw syncNotReady('The cluster has', olderNodes, indexName)
          await view.current(indexName)
        },
      }
      return serving
    },
    start: () => view.start(),
    async stop() {
      view.stop()
      await snapshots?.close()
    },
  }
}
