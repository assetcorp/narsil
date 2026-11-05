import { ErrorCodes, NarsilError } from '../../errors'
import type { SyncStorage } from '../../persistence/durability/sync/storage'
import { newSyncEpoch } from '../../sync/epoch'
import type { SyncSetting } from '../../types/sync'
import type { EngineCore } from '../core'
import type { IndexSyncState } from '../registry-entry'
import { withOpenIndex } from '../serial-index-update'
import { emitSyncChange } from '../sync-notify'
import { oneSyncChangeAtATime } from './serial'

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

async function persistSyncState(core: SyncCore, indexName: string, next: IndexSyncState | null): Promise<void> {
  const entry = core.requireIndex(indexName)
  const previous = entry.sync
  entry.sync = next
  try {
    await core.durability?.manager.persistMetadata(indexName)
  } catch (error) {
    entry.sync = previous
    throw error
  }
}

export function updateIndexSync(core: EngineCore, indexName: string, value: SyncSetting): Promise<void> {
  const setting = requireSyncSetting(value)
  core.requireIndex(indexName)
  const storage = syncStorageOf(core, indexName)
  return withOpenIndex(core, indexName, () =>
    oneSyncChangeAtATime(core.indexRegistry, indexName, async () => {
      const previous = core.requireIndex(indexName).sync
      if (!setting.enabled) {
        if (previous === null) return
        await persistSyncState(core, indexName, null)
        await storage.release(indexName)
        emitSyncChange(core.indexRegistry, { kind: 'off', indexName })
        return
      }
      const limits = {
        ...(setting.historyMaxAgeMs !== undefined ? { historyMaxAgeMs: setting.historyMaxAgeMs } : {}),
        ...(setting.historyMaxBytes !== undefined ? { historyMaxBytes: setting.historyMaxBytes } : {}),
      }
      if (previous !== null) {
        await persistSyncState(core, indexName, { ...limits, active: previous.active, epoch: previous.epoch })
        return
      }
      await storage.release(indexName)
      await persistSyncState(core, indexName, { ...limits, active: false, epoch: newSyncEpoch() })
    }),
  )
}

async function renewWhileHeld(core: SyncCore, indexName: string): Promise<void> {
  const sync = core.indexRegistry.get(indexName)?.sync ?? null
  if (sync === null) return
  await persistSyncState(core, indexName, { ...sync, active: false, epoch: newSyncEpoch() })
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
