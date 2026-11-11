import type * as SuggestionStoreCode from '../../query-suggestions/store-leaf'

type SuggestionStoreNames = Pick<
  typeof SuggestionStoreCode,
  | 'HEADER_SIZE'
  | 'MAX_HISTORY_FILE_BYTES'
  | 'QUERY_HISTORY_ARCHIVE_PREFIX'
  | 'QUERY_HISTORY_FOLDER'
  | 'attachedRuntimeOf'
  | 'checksumOfChunks'
  | 'crc32'
  | 'crc32Final'
  | 'crc32Init'
  | 'crc32Update'
  | 'engineVersionParts'
  | 'hasNrslMagic'
  | 'historyFileOf'
  | 'historyFilesOf'
  | 'listHistoryFolder'
  | 'oneSyncChangeAtATime'
  | 'openChecksummedEnvelope'
  | 'packChecksummedEnvelope'
  | 'packEnvelopeWithChecksum'
  | 'readHeader'
  | 'requireWithinFileLimit'
  | 'storedStateFromWire'
  | 'storedStateOf'
  | 'storedStateToWire'
  | 'writeHeader'
>

export let HEADER_SIZE: SuggestionStoreNames['HEADER_SIZE']
export let MAX_HISTORY_FILE_BYTES: SuggestionStoreNames['MAX_HISTORY_FILE_BYTES']
export let QUERY_HISTORY_ARCHIVE_PREFIX: SuggestionStoreNames['QUERY_HISTORY_ARCHIVE_PREFIX']
export let QUERY_HISTORY_FOLDER: SuggestionStoreNames['QUERY_HISTORY_FOLDER']
export let attachedRuntimeOf: SuggestionStoreNames['attachedRuntimeOf']
export let checksumOfChunks: SuggestionStoreNames['checksumOfChunks']
export let crc32: SuggestionStoreNames['crc32']
export let crc32Final: SuggestionStoreNames['crc32Final']
export let crc32Init: SuggestionStoreNames['crc32Init']
export let crc32Update: SuggestionStoreNames['crc32Update']
export let engineVersionParts: SuggestionStoreNames['engineVersionParts']
export let hasNrslMagic: SuggestionStoreNames['hasNrslMagic']
export let historyFileOf: SuggestionStoreNames['historyFileOf']
export let historyFilesOf: SuggestionStoreNames['historyFilesOf']
export let listHistoryFolder: SuggestionStoreNames['listHistoryFolder']
export let oneSyncChangeAtATime: SuggestionStoreNames['oneSyncChangeAtATime']
export let openChecksummedEnvelope: SuggestionStoreNames['openChecksummedEnvelope']
export let packChecksummedEnvelope: SuggestionStoreNames['packChecksummedEnvelope']
export let packEnvelopeWithChecksum: SuggestionStoreNames['packEnvelopeWithChecksum']
export let readHeader: SuggestionStoreNames['readHeader']
export let requireWithinFileLimit: SuggestionStoreNames['requireWithinFileLimit']
export let storedStateFromWire: SuggestionStoreNames['storedStateFromWire']
export let storedStateOf: SuggestionStoreNames['storedStateOf']
export let storedStateToWire: SuggestionStoreNames['storedStateToWire']
export let writeHeader: SuggestionStoreNames['writeHeader']

export function bindSuggestionStoreNames(suggestionStore: SuggestionStoreNames): void {
  ;({
    HEADER_SIZE,
    MAX_HISTORY_FILE_BYTES,
    QUERY_HISTORY_ARCHIVE_PREFIX,
    QUERY_HISTORY_FOLDER,
    attachedRuntimeOf,
    checksumOfChunks,
    crc32,
    crc32Final,
    crc32Init,
    crc32Update,
    engineVersionParts,
    hasNrslMagic,
    historyFileOf,
    historyFilesOf,
    listHistoryFolder,
    oneSyncChangeAtATime,
    openChecksummedEnvelope,
    packChecksummedEnvelope,
    packEnvelopeWithChecksum,
    readHeader,
    requireWithinFileLimit,
    storedStateFromWire,
    storedStateOf,
    storedStateToWire,
    writeHeader,
  } = suggestionStore)
}
