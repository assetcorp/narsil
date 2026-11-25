import { expansionSource } from '../../core/expansion/sources'
import { foldedSpellingSinks } from '../../core/folding/segment-registry'
import { captureFrozen, readFrozenSource } from '../../core/frozen-writes/regions'
import { fuzzyPrefixOf, fuzzyTermMatches } from '../../core/fuzzy'
import { withUnpairedSurrogatesReplaced } from '../../core/ordering/code-points'
import { partitionDocumentFrequency } from '../../core/partition/document-frequency'
import { loadSuggestions } from '../../core/partition/suggestion-code'
import { mergeText } from '../../core/segment-merges/text'
import { captureSegment, readMergeSegment } from '../../core/segment-writes/regions'
import { requireRoom, requireSegment, SegmentRefusal } from '../../core/segment-writes/status'
import { combinePostingLists } from '../../core/synonyms/combined-postings'
import { lookupExact, lookupPrefix } from '../../core/term-table/portable'
import { liveFrequency, termCount, termText } from '../../core/term-table/read'
import { tokenize } from '../../core/tokenizer'

export function textHostPart() {
  return {
    captureFrozen,
    captureSegment,
    combinePostingLists,
    expansionSource,
    foldedSpellingSinks,
    fuzzyPrefixOf,
    fuzzyTermMatches,
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
