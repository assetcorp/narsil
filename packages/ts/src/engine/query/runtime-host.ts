import { compareCodePoints } from '../../core/ordering/code-points'
import { projectionKeepsField, resolveProjection } from '../../core/projection'
import type { RuntimeHost } from '../../rerank/host'
import { isStringValuedBase, parsedTypeOf } from '../../schema/validator/field-type'
import { flattenSchema } from '../../schema/validator/schema'
import { decodePageCursor, encodePageCursor, requireMatchingCursor } from '../../search/cursor'
import { clampRowCount } from '../../search/pagination'
import { dedupePinnedEntries, placePinned } from '../../search/pinning-code'
import { normalizeSort } from '../../search/sorting'
import type { ScoredDocument } from '../../types/internal'
import type { VectorQueryConfig } from '../../types/search'
import { requireLoadedVectorCode } from '../../workers/vector-code'
import { now } from '../validation'
import { type FilteredSearch, filteredSearchOf } from './filter-subsets'
import type { SearchContext } from './shared'
import { textLeg } from './text-leg'
import { vectorQueryHost } from './vector-query-host'

export function vectorLeg(
  vectorConfig: VectorQueryConfig,
  queryVector: Float32Array,
  context: SearchContext,
  filtered: FilteredSearch | undefined,
  k: number,
  rescoreWindow?: number,
): Promise<{ scored: ScoredDocument[]; holdsEveryMatch: boolean }> {
  return requireLoadedVectorCode().vectorLegWith(
    vectorQueryHost,
    vectorConfig,
    queryVector,
    context,
    filtered,
    k,
    rescoreWindow,
  )
}

export const runtimeHost: RuntimeHost = {
  now,
  compareCodePoints,
  clampRowCount,
  resolveProjection,
  projectionKeepsField,
  decodePageCursor,
  encodePageCursor,
  requireMatchingCursor,
  dedupePinnedEntries,
  placePinned,
  normalizeSort,
  flattenSchema,
  parsedTypeOf,
  isStringValuedBase,
  textLeg,
  vectorLeg,
  filteredSearchOf,
  filterSubsetsMatchNothing: subsets => requireLoadedVectorCode().filterSubsetsMatchNothing(subsets),
  reciprocalRankFusion: (...args) => requireLoadedVectorCode().reciprocalRankFusion(...args),
  linearCombination: (...args) => requireLoadedVectorCode().linearCombination(...args),
  resolveHybridFusion: (...args) => requireLoadedVectorCode().resolveHybridFusion(...args),
}
