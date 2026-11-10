import type { OptionalCodeHost } from '../engine/optional-code-host'
import type * as SuggestionStoreCode from '../query-suggestions/store-leaf'

type EngineNames = Pick<
  OptionalCodeHost,
  'ErrorCodes' | 'NarsilError' | 'emitEngineEvent' | 'loadOptionalWrites' | 'loadStorageCode' | 'removeDocumentBatch'
>
type SuggestionStoreNames = Pick<
  typeof SuggestionStoreCode,
  | 'BUILD_WRITE_BATCH'
  | 'RestoredHistory'
  | 'attachedRuntimeOf'
  | 'clearLeftoversOfName'
  | 'installSuggestionHooks'
  | 'startQuerySuggestions'
  | 'unionOfBans'
  | 'withState'
>

export let ErrorCodes: EngineNames['ErrorCodes']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let emitEngineEvent: EngineNames['emitEngineEvent']
export let loadOptionalWrites: EngineNames['loadOptionalWrites']
export let loadStorageCode: EngineNames['loadStorageCode']
export let removeDocumentBatch: EngineNames['removeDocumentBatch']
export let BUILD_WRITE_BATCH: SuggestionStoreNames['BUILD_WRITE_BATCH']
export let RestoredHistory: SuggestionStoreNames['RestoredHistory']
export type RestoredHistory = InstanceType<SuggestionStoreNames['RestoredHistory']>
export let attachedRuntimeOf: SuggestionStoreNames['attachedRuntimeOf']
export let clearLeftoversOfName: SuggestionStoreNames['clearLeftoversOfName']
export let installSuggestionHooks: SuggestionStoreNames['installSuggestionHooks']
export let startQuerySuggestions: SuggestionStoreNames['startQuerySuggestions']
export let unionOfBans: SuggestionStoreNames['unionOfBans']
export let withState: SuggestionStoreNames['withState']

export function bindRestoreQueueHost(host: EngineNames, suggestionStore: SuggestionStoreNames): void {
  ;({ ErrorCodes, NarsilError, emitEngineEvent, loadOptionalWrites, loadStorageCode, removeDocumentBatch } = host)
  ;({
    BUILD_WRITE_BATCH,
    RestoredHistory,
    attachedRuntimeOf,
    clearLeftoversOfName,
    installSuggestionHooks,
    startQuerySuggestions,
    unionOfBans,
    withState,
  } = suggestionStore)
}
