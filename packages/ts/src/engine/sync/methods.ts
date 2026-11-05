import type { SyncSetting, SyncStatus } from '../../types/sync'
import type { EngineCore } from '../core'
import { updateIndexSync } from './operations'
import { syncStatusOf } from './status'

export async function updateSyncOf(core: EngineCore, indexName: string, setting: SyncSetting): Promise<void> {
  core.guardShutdown()
  core.requireIndex(indexName)
  await updateIndexSync(core, indexName, setting)
}

export function syncOf(core: EngineCore, indexName: string): SyncStatus {
  core.guardShutdown()
  return syncStatusOf(core.requireIndex(indexName).sync)
}
