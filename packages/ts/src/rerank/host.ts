import type { compareCodePoints } from '../core/ordering/code-points'
import type { projectionKeepsField, resolveProjection } from '../core/projection'
import type { filteredSearchOf } from '../engine/query/filter-subsets'
import type { vectorLeg } from '../engine/query/runtime-host'
import type { filterSubsetsMatchNothing } from '../engine/query/subset-search'
import type { textLeg } from '../engine/query/text-leg'
import type { now } from '../engine/validation'
import type { isStringValuedBase, parsedTypeOf } from '../schema/validator/field-type'
import type { flattenSchema } from '../schema/validator/schema'
import type { decodePageCursor, encodePageCursor, requireMatchingCursor } from '../search/cursor'
import type { linearCombination, reciprocalRankFusion, resolveHybridFusion } from '../search/fusion'
import type { clampRowCount } from '../search/pagination'
import type { dedupePinnedEntries, placePinned } from '../search/pinning'
import type { normalizeSort } from '../search/sorting'

export interface RuntimeHost {
  now: typeof now
  compareCodePoints: typeof compareCodePoints
  clampRowCount: typeof clampRowCount
  resolveProjection: typeof resolveProjection
  projectionKeepsField: typeof projectionKeepsField
  decodePageCursor: typeof decodePageCursor
  encodePageCursor: typeof encodePageCursor
  requireMatchingCursor: typeof requireMatchingCursor
  dedupePinnedEntries: typeof dedupePinnedEntries
  placePinned: typeof placePinned
  normalizeSort: typeof normalizeSort
  flattenSchema: typeof flattenSchema
  parsedTypeOf: typeof parsedTypeOf
  isStringValuedBase: typeof isStringValuedBase
  textLeg: typeof textLeg
  vectorLeg: typeof vectorLeg
  filteredSearchOf: typeof filteredSearchOf
  filterSubsetsMatchNothing: typeof filterSubsetsMatchNothing
  reciprocalRankFusion: typeof reciprocalRankFusion
  linearCombination: typeof linearCombination
  resolveHybridFusion: typeof resolveHybridFusion
}
