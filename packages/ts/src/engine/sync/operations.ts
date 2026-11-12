import {
  ErrorCodes,
  emitSyncChange,
  NarsilError,
  newSyncEpoch,
  oneSyncChangeAtATime,
  withOpenIndex,
} from '#platform/storage-host'
import type { SyncStorage } from '../../persistence/durability/sync/storage'
import type { StoredQuerySuggestions } from '../../types/internal'
import type { SyncSetting } from '../../types/sync'
import type { EngineCore } from '../core'
import type { IndexChangesState, IndexSyncState } from '../registry-entry'

type SyncCore = Pick<EngineCore, 'durability' | 'indexRegistry' | 'requireIndex'>
type RenewingCore = SyncCore & Pick<EngineCore, 'mutationCtx'>

function invalidLimit(name: string, value: unknown): never {
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, `The sync setting ${name} must be a positive whole number`, {
    [name]: String(value),
  })
}

export function requireSyncSetting(setting: unknown): SyncSetting {
  if (setting === null || typeof setting !== 'object') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The sync setting must be an object')
  }
  const { enabled, historyMaxAgeMs, historyMaxBytes } = setting as Record<string, unknown>
  if (typeof enabled !== 'boolean') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The sync setting needs enabled set to true or false')
  }
  const isLimit = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
  if (historyMaxAgeMs !== undefined && !isLimit(historyMaxAgeMs)) invalidLimit('historyMaxAgeMs', historyMaxAgeMs)
  if (historyMaxBytes !== undefined && !isLimit(historyMaxBytes)) invalidLimit('historyMaxBytes', historyMaxBytes)
  return {
    enabled,
    ...(historyMaxAgeMs !== undefined ? { historyMaxAgeMs } : {}),
    ...(historyMaxBytes !== undefined ? { historyMaxBytes } : {}),
  }
}

export function requireNoQuerySuggestions(state: StoredQuerySuggestions | null, indexName: string): void {
  if (state?.querySuggestions?.enabled !== true) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `Index "${indexName}" has popular query suggestions on, so it cannot sync to devices: a device receives the whole index of one user, while a suggestion comes from the searches of several people`,
    { indexName },
  )
}

export function syncStorageOf(core: Pick<EngineCore, 'durability'>, indexName: string): SyncStorage {
  const storage = core.durability?.manager.syncStorage?.()
  if (storage === undefined) {
    throw new NarsilError(
      ErrorCodes.SYNC_DURABILITY_REQUIRED,
      `Index "${indexName}" needs write-ahead log durability for device sync, because the feed reads the log`,
      { indexName },
    )
  }
  return storage
}

export interface EpochStates {
  sync: IndexSyncState | null
  changes: IndexChangesState | null
}

export async function persistEpochStates(core: SyncCore, indexName: string, next: EpochStates): Promise<void> {
  const entry = core.requireIndex(indexName)
  const previous: EpochStates = { sync: entry.sync, changes: entry.changes }
  entry.sync = next.sync
  entry.changes = next.changes
  try {
    await core.durability?.manager.persistMetadata(indexName)
  } catch (error) {
    entry.sync = previous.sync
    entry.changes = previous.changes
    throw error
  }
}

export function updateIndexSync(core: EngineCore, indexName: string, value: SyncSetting): Promise<void> {
  const setting = requireSyncSetting(value)
  core.requireIndex(indexName)
  const storage = syncStorageOf(core, indexName)
  return withOpenIndex(core, indexName, () =>
    oneSyncChangeAtATime(core.indexRegistry, indexName, async () => {
      if (setting.enabled) requireNoQuerySuggestions(core.requireIndex(indexName).querySuggestions, indexName)
      const { sync: previous, changes } = core.requireIndex(indexName)
      if (!setting.enabled) {
        if (previous === null) return
        await persistEpochStates(core, indexName, { sync: null, changes })
        await storage.release(indexName, changes !== null)
        emitSyncChange(core.indexRegistry, { kind: 'off', indexName })
        return
      }
      const limits = {
        ...(setting.historyMaxAgeMs !== undefined ? { historyMaxAgeMs: setting.historyMaxAgeMs } : {}),
        ...(setting.historyMaxBytes !== undefined ? { historyMaxBytes: setting.historyMaxBytes } : {}),
      }
      if (previous !== null) {
        await persistEpochStates(core, indexName, {
          sync: { ...limits, active: previous.active, epoch: previous.epoch },
          changes,
        })
        return
      }
      if (changes !== null) {
        await persistEpochStates(core, indexName, { sync: { ...limits, active: false, epoch: changes.epoch }, changes })
        return
      }
      await storage.release(indexName)
      await persistEpochStates(core, indexName, {
        sync: { ...limits, active: false, epoch: newSyncEpoch() },
        changes: null,
      })
    }),
  )
}

async function renewWhileHeld(core: SyncCore, indexName: string): Promise<void> {
  const entry = core.indexRegistry.get(indexName)
  if (entry === undefined) return
  const { sync, changes } = entry
  if (sync === null && changes === null) return
  const epoch = newSyncEpoch()
  await persistEpochStates(core, indexName, {
    sync: sync === null ? null : { ...sync, active: false, epoch },
    changes: changes === null ? null : { ...changes, epoch },
  })
  await core.durability?.manager.syncStorage?.().release(indexName)
  emitSyncChange(core.indexRegistry, { kind: 'epoch', indexName })
}

export function holdRenewedSyncEpoch(core: RenewingCore, indexName: string): Promise<() => void> {
  if (core.mutationCtx.capacityScope === 'partition') return Promise.resolve(() => undefined)
  return new Promise((resolveHold, rejectHold) => {
    void oneSyncChangeAtATime(core.indexRegistry, indexName, async () => {
      try {
        await renewWhileHeld(core, indexName)
      } catch (error) {
        rejectHold(error)
        return
      }
      await new Promise<void>(release => resolveHold(() => release()))
    })
  })
}
