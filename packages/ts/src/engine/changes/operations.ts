import {
  ErrorCodes,
  emitSyncChange,
  NarsilError,
  newSyncEpoch,
  oneSyncChangeAtATime,
  withOpenIndex,
} from '#platform/storage-host'
import type { SyncStorage } from '../../persistence/durability/sync/storage'
import type { ChangesSetting, ChangesStatus } from '../../types/changes'
import type { EngineCore } from '../core'
import type { IndexChangesState } from '../registry-entry'
import { persistEpochStates } from '../sync/operations'

function invalidLimit(name: string, value: unknown): never {
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, `The changes setting ${name} must be a positive whole number`, {
    [name]: String(value),
  })
}

export function requireChangesSetting(setting: unknown): ChangesSetting {
  if (setting === null || typeof setting !== 'object' || Array.isArray(setting)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The changes setting must be an object')
  }
  const { enabled, previousDocument, historyMaxAgeMs, historyMaxBytes } = setting as Record<string, unknown>
  if (typeof enabled !== 'boolean') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The changes setting needs enabled set to true or false')
  }
  if (previousDocument !== undefined && typeof previousDocument !== 'boolean') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The changes setting previousDocument must be true or false')
  }
  const isLimit = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
  if (historyMaxAgeMs !== undefined && !isLimit(historyMaxAgeMs)) invalidLimit('historyMaxAgeMs', historyMaxAgeMs)
  if (historyMaxBytes !== undefined && !isLimit(historyMaxBytes)) invalidLimit('historyMaxBytes', historyMaxBytes)
  return {
    enabled,
    ...(previousDocument !== undefined ? { previousDocument } : {}),
    ...(historyMaxAgeMs !== undefined ? { historyMaxAgeMs } : {}),
    ...(historyMaxBytes !== undefined ? { historyMaxBytes } : {}),
  }
}

export function changesStorageOf(core: Pick<EngineCore, 'durability'>, indexName: string): SyncStorage {
  const storage = core.durability?.manager.syncStorage?.()
  if (storage === undefined) {
    throw new NarsilError(
      ErrorCodes.CHANGES_DURABILITY_REQUIRED,
      `Index "${indexName}" needs write-ahead log durability for change capture, because the feed reads the log`,
      { indexName },
    )
  }
  return storage
}

export function changesStatusOf(changes: IndexChangesState | null): ChangesStatus {
  if (changes === null) return { enabled: false, previousDocument: false, epoch: null }
  return {
    enabled: true,
    previousDocument: changes.previousDocument,
    ...(changes.historyMaxAgeMs !== undefined ? { historyMaxAgeMs: changes.historyMaxAgeMs } : {}),
    ...(changes.historyMaxBytes !== undefined ? { historyMaxBytes: changes.historyMaxBytes } : {}),
    epoch: changes.epoch,
  }
}

function nextState(setting: ChangesSetting, epoch: string): IndexChangesState {
  return {
    previousDocument: setting.previousDocument === true,
    ...(setting.historyMaxAgeMs !== undefined ? { historyMaxAgeMs: setting.historyMaxAgeMs } : {}),
    ...(setting.historyMaxBytes !== undefined ? { historyMaxBytes: setting.historyMaxBytes } : {}),
    epoch,
  }
}

async function turnOff(core: EngineCore, indexName: string, storage: SyncStorage): Promise<void> {
  const { sync, changes } = core.requireIndex(indexName)
  if (changes === null) return
  await persistEpochStates(core, indexName, { sync, changes: null })
  if (sync?.active !== true) await storage.release(indexName)
  emitSyncChange(core.indexRegistry, { kind: 'changes-off', indexName })
}

async function turnOn(core: EngineCore, indexName: string, storage: SyncStorage, setting: ChangesSetting) {
  const { sync, changes } = core.requireIndex(indexName)
  if (changes !== null) {
    await persistEpochStates(core, indexName, { sync, changes: nextState(setting, changes.epoch) })
    if (changes.previousDocument && setting.previousDocument !== true) {
      emitSyncChange(core.indexRegistry, { kind: 'previous-document-off', indexName })
    }
    return
  }
  if (sync !== null) {
    await persistEpochStates(core, indexName, { sync, changes: nextState(setting, sync.epoch) })
    return
  }
  await storage.release(indexName)
  await persistEpochStates(core, indexName, { sync: null, changes: nextState(setting, newSyncEpoch()) })
}

export function updateIndexChanges(core: EngineCore, indexName: string, value: ChangesSetting): Promise<void> {
  const setting = requireChangesSetting(value)
  core.requireIndex(indexName)
  const storage = changesStorageOf(core, indexName)
  return withOpenIndex(core, indexName, () =>
    oneSyncChangeAtATime(core.indexRegistry, indexName, () =>
      setting.enabled ? turnOn(core, indexName, storage, setting) : turnOff(core, indexName, storage),
    ),
  )
}

export async function updateChangesOf(core: EngineCore, indexName: string, setting: ChangesSetting): Promise<void> {
  core.guardShutdown()
  core.requireIndex(indexName)
  await updateIndexChanges(core, indexName, setting)
}

export function changesOf(core: EngineCore, indexName: string): ChangesStatus {
  core.guardShutdown()
  return changesStatusOf(core.requireIndex(indexName).changes)
}
