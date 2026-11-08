import type { OptionalCodeHost } from '../engine/optional-code-host'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'ErrorCodes'
  | 'NarsilError'
  | 'RestoredHistory'
  | 'attachedRuntimeOf'
  | 'clearLeftoversOfName'
  | 'emitEngineEvent'
  | 'installSuggestionHooks'
  | 'loadStorageCode'
  | 'removeDocumentBatch'
  | 'unionOfBans'
  | 'withState'
>

export let ErrorCodes: EngineNames['ErrorCodes']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let RestoredHistory: EngineNames['RestoredHistory']
export type RestoredHistory = InstanceType<EngineNames['RestoredHistory']>
export let attachedRuntimeOf: EngineNames['attachedRuntimeOf']
export let clearLeftoversOfName: EngineNames['clearLeftoversOfName']
export let emitEngineEvent: EngineNames['emitEngineEvent']
export let installSuggestionHooks: EngineNames['installSuggestionHooks']
export let loadStorageCode: EngineNames['loadStorageCode']
export let removeDocumentBatch: EngineNames['removeDocumentBatch']
export let unionOfBans: EngineNames['unionOfBans']
export let withState: EngineNames['withState']

export function bindRestoreQueueHost(host: EngineNames): void {
  ;({
    ErrorCodes,
    NarsilError,
    RestoredHistory,
    attachedRuntimeOf,
    clearLeftoversOfName,
    emitEngineEvent,
    installSuggestionHooks,
    loadStorageCode,
    removeDocumentBatch,
    unionOfBans,
    withState,
  } = host)
}
