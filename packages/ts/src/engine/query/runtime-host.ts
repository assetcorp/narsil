import { compareCodePoints } from '../../core/ordering/code-points'
import { projectionKeepsField, resolveProjection } from '../../core/projection'
import type { RuntimeHost } from '../../rerank/host'
import { isStringValuedBase, parsedTypeOf } from '../../schema/validator/field-type'
import { flattenSchema } from '../../schema/validator/schema'
import { decodePageCursor, encodePageCursor, requireMatchingCursor } from '../../search/cursor'
import { linearCombination, reciprocalRankFusion, resolveHybridFusion } from '../../search/fusion'
import { clampRowCount } from '../../search/pagination'
import { dedupePinnedEntries, placePinned } from '../../search/pinning'
import { normalizeSort } from '../../search/sorting'
import { now } from '../validation'
import { filterSubsetsMatchNothing } from './filter-subsets'
import { applyHighlights } from './highlight'
import { filteredSearchOf, textLeg, vectorLeg } from './vector'

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
  applyHighlights,
  textLeg,
  vectorLeg,
  filteredSearchOf,
  filterSubsetsMatchNothing,
  reciprocalRankFusion,
  linearCombination,
  resolveHybridFusion,
}
