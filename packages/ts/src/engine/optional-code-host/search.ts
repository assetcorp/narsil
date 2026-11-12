import { turnIsSpent, yieldTurn } from '#platform/turn-budget'
import { partitionsIn } from '../../partitioning/partition-selection'
import {
  DEFAULT_MAX_RERANK_WINDOW,
  DEFAULT_RERANK_TIMEOUT_MS,
  DEFAULT_RERANK_WINDOW,
  MAX_RERANK_TIMEOUT_MS,
  MAX_RERANK_WINDOW,
  MIN_RERANK_TIMEOUT_MS,
  MIN_RERANK_WINDOW,
} from '../../rerank/constants'
import {
  DEFAULT_MAX_PER_GROUP,
  HYBRID_RESCORE_WINDOW,
  MAX_HYBRID_DEPTH,
  MAX_PHRASE_WORDS,
  MAX_QUERY_PHRASES,
  MIN_HYBRID_DEPTH,
  RESULT_WINDOW,
} from '../../search/constants'
import { decodePageCursor, encodePageCursor, requireMatchingCursor, sortSignatureOf } from '../../search/cursor'
import { listBindingOf } from '../../search/cursor-binding'
import { everyValueFacetConfig, mergeFacets } from '../../search/facets'
import { fulltextMatches } from '../../search/fulltext'
import { clampRowCount, requireWithinResultWindow } from '../../search/pagination'
import { normalizeSort, sortModesOf } from '../../search/sorting'
import {
  DEFAULT_LIMIT,
  DEFAULT_OFFSET,
  DEFAULT_SUGGEST_LIMIT,
  MAX_CALLS_ACROSS_INDEX_CHANGES,
  MAX_SUGGEST_LIMIT,
  MAX_SUGGEST_SCATTER_LIMIT,
} from '../constants'
import { applyHighlights } from '../query/highlight'
import { clampLimit, now } from '../validation'

export function searchHostPart() {
  return {
    applyHighlights,
    clampLimit,
    clampRowCount,
    decodePageCursor,
    DEFAULT_LIMIT,
    DEFAULT_MAX_PER_GROUP,
    DEFAULT_MAX_RERANK_WINDOW,
    DEFAULT_OFFSET,
    DEFAULT_RERANK_TIMEOUT_MS,
    DEFAULT_RERANK_WINDOW,
    DEFAULT_SUGGEST_LIMIT,
    encodePageCursor,
    everyValueFacetConfig,
    fulltextMatches,
    HYBRID_RESCORE_WINDOW,
    listBindingOf,
    MAX_HYBRID_DEPTH,
    MAX_PHRASE_WORDS,
    MAX_CALLS_ACROSS_INDEX_CHANGES,
    MAX_QUERY_PHRASES,
    MAX_RERANK_TIMEOUT_MS,
    MAX_RERANK_WINDOW,
    MAX_SUGGEST_LIMIT,
    MAX_SUGGEST_SCATTER_LIMIT,
    mergeFacets,
    MIN_HYBRID_DEPTH,
    MIN_RERANK_TIMEOUT_MS,
    MIN_RERANK_WINDOW,
    normalizeSort,
    now,
    partitionsIn,
    requireMatchingCursor,
    requireWithinResultWindow,
    RESULT_WINDOW,
    sortModesOf,
    sortSignatureOf,
    turnIsSpent,
    yieldTurn,
  }
}
