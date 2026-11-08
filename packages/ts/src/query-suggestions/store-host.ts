import type { OptionalCodeHost } from '../engine/optional-code-host'

export { encode } from '@msgpack/msgpack'
export { VERSION } from '..'
export { dropEngineIndex } from '../engine/index-lifecycle'
export { emitWriteEventAfter } from '../engine/write-events'
export { ErrorCodes, NarsilError } from '../errors'
export { flattenSchema } from '../schema/validator'
export { CHECKSUM_YIELD_CHUNK_BYTES, MAX_FILE_BYTES, NATIVE_CRC32_MIN_BYTES } from '../serialization/constants'
export { GROUP_PATTERN_SOURCE } from './index-names/constants'
export { loadSuggestionsCode } from './suggestions-code'

export function bindSuggestionStoreHost(_host: OptionalCodeHost): void {}
