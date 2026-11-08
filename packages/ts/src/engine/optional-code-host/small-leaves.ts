import { removeDocumentBatch } from '#platform/memory-guarded-writes'
import { VERSION } from '../..'
import { loadDigest } from '../../persistence/digest-code'
import {
  GROUP_FORMAT,
  GROUP_PATTERN_SOURCE,
  SUGGESTIONS_INDEX_INFIX,
} from '../../query-suggestions/index-names/constants'
import { loadSuggestionsCode } from '../../query-suggestions/suggestions-code'
import { CHECKSUM_YIELD_CHUNK_BYTES, NATIVE_CRC32_MIN_BYTES } from '../../serialization/constants'
import { createEngineIndex, dropEngineIndex } from '../index-lifecycle'
import { emitWriteEventAfter } from '../write-events'

export function smallLeavesHostPart() {
  return {
    CHECKSUM_YIELD_CHUNK_BYTES,
    GROUP_FORMAT,
    GROUP_PATTERN_SOURCE,
    NATIVE_CRC32_MIN_BYTES,
    SUGGESTIONS_INDEX_INFIX,
    VERSION,
    createEngineIndex,
    dropEngineIndex,
    emitWriteEventAfter,
    loadDigest,
    loadSuggestionsCode,
    removeDocumentBatch,
  }
}
