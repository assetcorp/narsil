import { bitsetClear, bitsetFromSet, bitsetHas, bitsetSet, createBitSet } from '../../core/bitset'
import { lowerBound } from '../../core/field-index/numeric/storage'
import { FieldPresence } from '../../core/field-index/presence'
import { FILTER_RADIUS } from '../../core/filters/layout'
import { codePointCount, compareCodePoints } from '../../core/ordering/code-points'
import { SORT_VALUE_MAX_CODE_POINTS } from '../../core/ordering/constants'
import { compareScores } from '../../core/ordering/scores'
import {
  defaultSortMode,
  isSortMode,
  SORT_MODES,
  toComparableSortValue,
  truncateSortString,
} from '../../core/ordering/sort-values'
import { subMatchesView } from '../../core/partition/composite/filters'
import {
  SORT_COLUMN_MINIMUM_REBUILD_THRESHOLD,
  SORT_COLUMN_REBUILD_FRACTION_SHIFT,
} from '../../core/partition/constants'
import { keptFacetValues } from '../../core/partition/facet-limit'
import { GrowableUint32 } from '../../core/partition/growable-uint32'
import { sortedPageOf } from '../../core/partition/sorting'
import { getFlatSchema } from '../../core/partition/utils'
import { createPatternWorkMeter } from '../../core/pattern-index/work-meter'
import { resolveProjection } from '../../core/projection'
import { regionsOverlap } from '../../core/regions'
import { buildStoredValues } from '../../core/stored-values/build'
import { storedValuesOf } from '../../core/stored-values/columns'
import { readStoredFields, validStoredValue } from '../../core/stored-values/read'
import { typedRegion } from '../../core/stored-values/regions'
import { checkedSize } from '../../core/stored-values/storage'
import { storedText } from '../../core/stored-values/text'
import { ErrorCodes, NarsilError } from '../../errors'

export function coreHostPart() {
  return {
    bitsetClear,
    bitsetFromSet,
    bitsetHas,
    bitsetSet,
    buildStoredValues,
    checkedSize,
    codePointCount,
    compareCodePoints,
    compareScores,
    createBitSet,
    createPatternWorkMeter,
    defaultSortMode,
    ErrorCodes,
    FieldPresence,
    FILTER_RADIUS,
    getFlatSchema,
    GrowableUint32,
    isSortMode,
    keptFacetValues,
    lowerBound,
    NarsilError,
    readStoredFields,
    regionsOverlap,
    resolveProjection,
    SORT_COLUMN_MINIMUM_REBUILD_THRESHOLD,
    SORT_COLUMN_REBUILD_FRACTION_SHIFT,
    SORT_MODES,
    SORT_VALUE_MAX_CODE_POINTS,
    sortedPageOf,
    storedText,
    storedValuesOf,
    subMatchesView,
    toComparableSortValue,
    truncateSortString,
    typedRegion,
    validStoredValue,
  }
}
