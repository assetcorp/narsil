import { changesStatusOf } from '../../../engine/changes/operations'
import type { IndexChangesState, IndexSyncState } from '../../../engine/registry-entry'
import { getLanguage, hasLanguage } from '../../../languages/registry'
import type { SyncSettings } from '../../../sync/protocol'
import type { ChangesStatus } from '../../../types/changes'
import type { SyncStatus } from '../../../types/sync'
import type { SynonymRule } from '../../../types/synonyms'
import type { IndexSettings } from '../../cluster/index-settings'

export interface ServingLayout {
  servingName: string
  indexUuid: string
  partitionCount: number
}

export interface HeldSyncIndex {
  indexUuid: string
  settings: IndexSettings | undefined
  serving: ServingLayout
  feedSettings: SyncSettings
  synonymsGeneration: string | null
}

export function syncStateOfSettings(settings: IndexSettings | undefined): IndexSyncState | null {
  const setting = settings?.sync
  if (setting === undefined || !setting.enabled || settings?.syncEpoch === undefined) return null
  return {
    ...(setting.historyMaxAgeMs !== undefined ? { historyMaxAgeMs: setting.historyMaxAgeMs } : {}),
    ...(setting.historyMaxBytes !== undefined ? { historyMaxBytes: setting.historyMaxBytes } : {}),
    active: settings?.syncActive === true,
    epoch: settings.syncEpoch,
  }
}

export function changesStateOfSettings(settings: IndexSettings | undefined): IndexChangesState | null {
  const setting = settings?.changes
  if (setting === undefined || !setting.enabled || settings?.syncEpoch === undefined) return null
  return {
    previousDocument: setting.previousDocument === true,
    ...(setting.historyMaxAgeMs !== undefined ? { historyMaxAgeMs: setting.historyMaxAgeMs } : {}),
    ...(setting.historyMaxBytes !== undefined ? { historyMaxBytes: setting.historyMaxBytes } : {}),
    epoch: settings.syncEpoch,
  }
}

export function changesStatusOfSettings(settings: IndexSettings | undefined): ChangesStatus {
  return changesStatusOf(changesStateOfSettings(settings))
}

export function syncStatusOfSettings(settings: IndexSettings | undefined): SyncStatus {
  const state = syncStateOfSettings(settings)
  if (state === null) return { enabled: false, active: false, epoch: null }
  return { enabled: true, ...state }
}

function analysisRevisionOf(language: string): string | undefined {
  if (!hasLanguage(language)) return undefined
  return getLanguage(language).revision
}

export function feedSettingsOf(settings: IndexSettings | undefined, synonyms: readonly SynonymRule[]): SyncSettings {
  const language = settings?.language ?? getLanguage('english').name
  const revision = analysisRevisionOf(language)
  return {
    language,
    ...(settings?.tokenizer !== undefined ? { tokenizer: settings.tokenizer } : {}),
    ...(settings?.stopWords !== undefined ? { stopWords: settings.stopWords } : {}),
    ...(settings?.stopWordList !== undefined ? { stopWordList: settings.stopWordList } : {}),
    ...(revision !== undefined ? { analysisRevision: revision } : {}),
    ...(settings?.bm25 !== undefined ? { bm25: settings.bm25 } : {}),
    ...(synonyms.length > 0 ? { synonyms: [...synonyms] } : {}),
  }
}

export type HeldSyncChange = 'epoch' | 'off' | 'settings' | 'dropped' | null

export type HeldChangesChange = 'epoch' | 'changes-off' | 'previous-document-off' | 'dropped' | null

function sameFeedSettings(held: HeldSyncIndex, next: HeldSyncIndex): boolean {
  const a = held.settings
  const b = next.settings
  return (
    held.synonymsGeneration === next.synonymsGeneration &&
    a?.language === b?.language &&
    a?.tokenizer === b?.tokenizer &&
    a?.stopWords === b?.stopWords &&
    JSON.stringify(a?.stopWordList ?? null) === JSON.stringify(b?.stopWordList ?? null) &&
    (a?.bm25Revision ?? 0) === (b?.bm25Revision ?? 0)
  )
}

export function changeBetween(held: HeldSyncIndex | undefined, next: HeldSyncIndex | null): HeldSyncChange {
  const before = held === undefined ? null : syncStateOfSettings(held.settings)
  if (held === undefined || before === null) return null
  if (next === null || next.indexUuid !== held.indexUuid) return 'dropped'
  const after = syncStateOfSettings(next.settings)
  if (after === null) return 'off'
  if (after.epoch !== before.epoch || next.serving.partitionCount !== held.serving.partitionCount) return 'epoch'
  return sameFeedSettings(held, next) ? null : 'settings'
}

export function changesChangeBetween(held: HeldSyncIndex | undefined, next: HeldSyncIndex | null): HeldChangesChange {
  const before = held === undefined ? null : changesStateOfSettings(held.settings)
  if (held === undefined || before === null) return null
  if (next === null || next.indexUuid !== held.indexUuid) return 'dropped'
  const after = changesStateOfSettings(next.settings)
  if (after === null) return 'changes-off'
  if (after.epoch !== before.epoch || next.serving.partitionCount !== held.serving.partitionCount) return 'epoch'
  return before.previousDocument && !after.previousDocument ? 'previous-document-off' : null
}
