import { expansionSource } from '../../core/expansion/sources'
import { captureFrozen, readFrozenSource } from '../../core/frozen-writes/regions'
import { withUnpairedSurrogatesReplaced } from '../../core/ordering/code-points'
import { partitionDocumentFrequency } from '../../core/partition/document-frequency'
import { loadSuggestions } from '../../core/partition/suggestion-code'
import { mergeText } from '../../core/segment-merges/text'
import { captureSegment, readMergeSegment } from '../../core/segment-writes/regions'
import { requireRoom, requireSegment, SegmentRefusal } from '../../core/segment-writes/status'
import { lookupExact, lookupPrefix } from '../../core/term-table/portable'
import { liveFrequency, termCount, termText } from '../../core/term-table/read'
import { tokenize } from '../../core/tokenizer'

export function textHostPart() {
  return {
    captureFrozen,
    captureSegment,
    expansionSource,
    liveFrequency,
    loadSuggestions,
    lookupExact,
    lookupPrefix,
    mergeText,
    partitionDocumentFrequency,
    readFrozenSource,
    readMergeSegment,
    requireRoom,
    requireSegment,
    SegmentRefusal,
    termCount,
    termText,
    tokenize,
    withUnpairedSurrogatesReplaced,
  }
}
