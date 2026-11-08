import type { OptionalCodeHost } from '../engine/optional-code-host'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'CHECKSUM_YIELD_CHUNK_BYTES'
  | 'ErrorCodes'
  | 'GROUP_PATTERN_SOURCE'
  | 'MAX_FILE_BYTES'
  | 'NATIVE_CRC32_MIN_BYTES'
  | 'NarsilError'
  | 'VERSION'
  | 'dropEngineIndex'
  | 'emitWriteEventAfter'
  | 'encode'
  | 'flattenSchema'
  | 'loadSuggestionsCode'
>

export let CHECKSUM_YIELD_CHUNK_BYTES: EngineNames['CHECKSUM_YIELD_CHUNK_BYTES']
export let ErrorCodes: EngineNames['ErrorCodes']
export let GROUP_PATTERN_SOURCE: EngineNames['GROUP_PATTERN_SOURCE']
export let MAX_FILE_BYTES: EngineNames['MAX_FILE_BYTES']
export let NATIVE_CRC32_MIN_BYTES: EngineNames['NATIVE_CRC32_MIN_BYTES']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let VERSION: EngineNames['VERSION']
export let dropEngineIndex: EngineNames['dropEngineIndex']
export let emitWriteEventAfter: EngineNames['emitWriteEventAfter']
export let encode: EngineNames['encode']
export let flattenSchema: EngineNames['flattenSchema']
export let loadSuggestionsCode: EngineNames['loadSuggestionsCode']

export function bindSuggestionStoreHost(host: EngineNames): void {
  ;({
    CHECKSUM_YIELD_CHUNK_BYTES,
    ErrorCodes,
    GROUP_PATTERN_SOURCE,
    MAX_FILE_BYTES,
    NATIVE_CRC32_MIN_BYTES,
    NarsilError,
    VERSION,
    dropEngineIndex,
    emitWriteEventAfter,
    encode,
    flattenSchema,
    loadSuggestionsCode,
  } = host)
}
