import type { OptionalCodeHost } from '../engine/optional-code-host'
import type * as SuggestionStoreCode from './store-leaf'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'ErrorCodes'
  | 'GROUP_FORMAT'
  | 'NarsilError'
  | 'SUGGESTIONS_INDEX_INFIX'
  | 'compareCodePoints'
  | 'createEngineIndex'
  | 'decode'
  | 'emitEngineEvent'
  | 'emitWriteEventAfter'
  | 'encode'
  | 'loadDigest'
  | 'spawnNodeWorker'
  | 'withOpenIndex'
>
type SuggestionStoreNames = Pick<
  typeof SuggestionStoreCode,
  | 'BUILD_LIST_PAGE'
  | 'BUILD_WRITE_BATCH'
  | 'BYTES_PER_MIB'
  | 'DAY_MS'
  | 'DEFAULT_PREVIEW_LIMIT'
  | 'DayStore'
  | 'HISTORY_SWEEP_INTERVAL_MS'
  | 'KEY_FINGERPRINT_BYTES'
  | 'KEY_FINGERPRINT_LABEL'
  | 'MAX_MANUAL_SUGGESTION_COUNT'
  | 'MAX_PREVIEW_LIMIT'
  | 'MAX_SOURCE_INDEX_NAME_LENGTH'
  | 'MAX_TIMER_DELAY_MS'
  | 'MIN_KEY_BYTES'
  | 'MS_PER_SECOND'
  | 'RestoredHistory'
  | 'SCHEDULE_OFF'
  | 'SCRAMBLED_ID_BYTES'
  | 'acceptedPhrase'
  | 'attachRuntime'
  | 'attachedRuntimeOf'
  | 'banListFromInput'
  | 'buildRecordKey'
  | 'crc32'
  | 'dayOf'
  | 'historyFileOf'
  | 'historyFilesOf'
  | 'installSuggestionHooks'
  | 'invalidSetting'
  | 'isGroup'
  | 'isPerson'
  | 'latestMatchAtOrBefore'
  | 'listHistoryFolder'
  | 'nextMatchAfter'
  | 'normaliseBan'
  | 'oneSyncChangeAtATime'
  | 'openChecksummedEnvelope'
  | 'openCountsFile'
  | 'packEnvelopeWithChecksum'
  | 'parseSchedule'
  | 'removeHistoryFolder'
  | 'removeRestoreLeftovers'
  | 'requireFieldsInSchema'
  | 'resolveSetting'
  | 'sameBytes'
  | 'validateSetting'
  | 'withState'
>

export let ErrorCodes: EngineNames['ErrorCodes']
export let GROUP_FORMAT: EngineNames['GROUP_FORMAT']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let SUGGESTIONS_INDEX_INFIX: EngineNames['SUGGESTIONS_INDEX_INFIX']
export let compareCodePoints: EngineNames['compareCodePoints']
export let createEngineIndex: EngineNames['createEngineIndex']
export let decode: EngineNames['decode']
export let emitEngineEvent: EngineNames['emitEngineEvent']
export let emitWriteEventAfter: EngineNames['emitWriteEventAfter']
export let encode: EngineNames['encode']
export let loadDigest: EngineNames['loadDigest']
export let spawnNodeWorker: EngineNames['spawnNodeWorker']
export let withOpenIndex: EngineNames['withOpenIndex']
export let BUILD_LIST_PAGE: SuggestionStoreNames['BUILD_LIST_PAGE']
export let BUILD_WRITE_BATCH: SuggestionStoreNames['BUILD_WRITE_BATCH']
export let BYTES_PER_MIB: SuggestionStoreNames['BYTES_PER_MIB']
export let DAY_MS: SuggestionStoreNames['DAY_MS']
export let DEFAULT_PREVIEW_LIMIT: SuggestionStoreNames['DEFAULT_PREVIEW_LIMIT']
export let DayStore: SuggestionStoreNames['DayStore']
export type DayStore = InstanceType<SuggestionStoreNames['DayStore']>
export let HISTORY_SWEEP_INTERVAL_MS: SuggestionStoreNames['HISTORY_SWEEP_INTERVAL_MS']
export let KEY_FINGERPRINT_BYTES: SuggestionStoreNames['KEY_FINGERPRINT_BYTES']
export let KEY_FINGERPRINT_LABEL: SuggestionStoreNames['KEY_FINGERPRINT_LABEL']
export let MAX_MANUAL_SUGGESTION_COUNT: SuggestionStoreNames['MAX_MANUAL_SUGGESTION_COUNT']
export let MAX_PREVIEW_LIMIT: SuggestionStoreNames['MAX_PREVIEW_LIMIT']
export let MAX_SOURCE_INDEX_NAME_LENGTH: SuggestionStoreNames['MAX_SOURCE_INDEX_NAME_LENGTH']
export let MAX_TIMER_DELAY_MS: SuggestionStoreNames['MAX_TIMER_DELAY_MS']
export let MIN_KEY_BYTES: SuggestionStoreNames['MIN_KEY_BYTES']
export let MS_PER_SECOND: SuggestionStoreNames['MS_PER_SECOND']
export let RestoredHistory: SuggestionStoreNames['RestoredHistory']
export type RestoredHistory = InstanceType<SuggestionStoreNames['RestoredHistory']>
export let SCHEDULE_OFF: SuggestionStoreNames['SCHEDULE_OFF']
export let SCRAMBLED_ID_BYTES: SuggestionStoreNames['SCRAMBLED_ID_BYTES']
export let acceptedPhrase: SuggestionStoreNames['acceptedPhrase']
export let attachRuntime: SuggestionStoreNames['attachRuntime']
export let attachedRuntimeOf: SuggestionStoreNames['attachedRuntimeOf']
export let banListFromInput: SuggestionStoreNames['banListFromInput']
export let buildRecordKey: SuggestionStoreNames['buildRecordKey']
export let crc32: SuggestionStoreNames['crc32']
export let dayOf: SuggestionStoreNames['dayOf']
export let historyFileOf: SuggestionStoreNames['historyFileOf']
export let historyFilesOf: SuggestionStoreNames['historyFilesOf']
export let installSuggestionHooks: SuggestionStoreNames['installSuggestionHooks']
export let invalidSetting: SuggestionStoreNames['invalidSetting']
export let isGroup: SuggestionStoreNames['isGroup']
export let isPerson: SuggestionStoreNames['isPerson']
export let latestMatchAtOrBefore: SuggestionStoreNames['latestMatchAtOrBefore']
export let listHistoryFolder: SuggestionStoreNames['listHistoryFolder']
export let nextMatchAfter: SuggestionStoreNames['nextMatchAfter']
export let normaliseBan: SuggestionStoreNames['normaliseBan']
export let oneSyncChangeAtATime: SuggestionStoreNames['oneSyncChangeAtATime']
export let openChecksummedEnvelope: SuggestionStoreNames['openChecksummedEnvelope']
export let openCountsFile: SuggestionStoreNames['openCountsFile']
export let packEnvelopeWithChecksum: SuggestionStoreNames['packEnvelopeWithChecksum']
export let parseSchedule: SuggestionStoreNames['parseSchedule']
export let removeHistoryFolder: SuggestionStoreNames['removeHistoryFolder']
export let removeRestoreLeftovers: SuggestionStoreNames['removeRestoreLeftovers']
export let requireFieldsInSchema: SuggestionStoreNames['requireFieldsInSchema']
export let resolveSetting: SuggestionStoreNames['resolveSetting']
export let sameBytes: SuggestionStoreNames['sameBytes']
export let validateSetting: SuggestionStoreNames['validateSetting']
export let withState: SuggestionStoreNames['withState']

export function bindSuggestionsHost(host: EngineNames, suggestionStore: SuggestionStoreNames): void {
  ;({
    ErrorCodes,
    GROUP_FORMAT,
    NarsilError,
    SUGGESTIONS_INDEX_INFIX,
    compareCodePoints,
    createEngineIndex,
    decode,
    emitEngineEvent,
    emitWriteEventAfter,
    encode,
    loadDigest,
    spawnNodeWorker,
    withOpenIndex,
  } = host)
  ;({
    BUILD_LIST_PAGE,
    BUILD_WRITE_BATCH,
    BYTES_PER_MIB,
    DAY_MS,
    DEFAULT_PREVIEW_LIMIT,
    DayStore,
    HISTORY_SWEEP_INTERVAL_MS,
    KEY_FINGERPRINT_BYTES,
    KEY_FINGERPRINT_LABEL,
    MAX_MANUAL_SUGGESTION_COUNT,
    MAX_PREVIEW_LIMIT,
    MAX_SOURCE_INDEX_NAME_LENGTH,
    MAX_TIMER_DELAY_MS,
    MIN_KEY_BYTES,
    MS_PER_SECOND,
    RestoredHistory,
    SCHEDULE_OFF,
    SCRAMBLED_ID_BYTES,
    acceptedPhrase,
    attachRuntime,
    attachedRuntimeOf,
    banListFromInput,
    buildRecordKey,
    crc32,
    dayOf,
    historyFileOf,
    historyFilesOf,
    installSuggestionHooks,
    invalidSetting,
    isGroup,
    isPerson,
    latestMatchAtOrBefore,
    listHistoryFolder,
    nextMatchAfter,
    normaliseBan,
    oneSyncChangeAtATime,
    openChecksummedEnvelope,
    openCountsFile,
    packEnvelopeWithChecksum,
    parseSchedule,
    removeHistoryFolder,
    removeRestoreLeftovers,
    requireFieldsInSchema,
    resolveSetting,
    sameBytes,
    validateSetting,
    withState,
  } = suggestionStore)
}
