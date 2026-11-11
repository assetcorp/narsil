import type { OptionalCodeHost } from './optional-code-host'

type OptionalReadsHost = Pick<
  OptionalCodeHost,
  | 'bitsetClear'
  | 'bitsetFromSet'
  | 'bitsetSet'
  | 'buildStoredValues'
  | 'captureFrozen'
  | 'captureSegment'
  | 'checkedSize'
  | 'clampLimit'
  | 'clampRowCount'
  | 'codePointCount'
  | 'compareCodePoints'
  | 'compareScores'
  | 'createBitSet'
  | 'createPatternWorkMeter'
  | 'decodePageCursor'
  | 'DEFAULT_MAX_PER_GROUP'
  | 'DEFAULT_SUGGEST_LIMIT'
  | 'defaultSortMode'
  | 'encodePageCursor'
  | 'ErrorCodes'
  | 'everyValueFacetConfig'
  | 'expansionSource'
  | 'flattenSchema'
  | 'fulltextMatches'
  | 'getFlatSchema'
  | 'isGeopointOrVectorType'
  | 'isListBase'
  | 'isSortMode'
  | 'isStringValuedBase'
  | 'keptFacetValues'
  | 'listBindingOf'
  | 'liveFrequency'
  | 'loadSuggestions'
  | 'lookupExact'
  | 'lookupPrefix'
  | 'lowerBound'
  | 'MAX_SUGGEST_LIMIT'
  | 'MAX_SUGGEST_SCATTER_LIMIT'
  | 'mergeFacets'
  | 'mergeText'
  | 'NarsilError'
  | 'normalizeSort'
  | 'now'
  | 'parsedTypeOf'
  | 'partitionDocumentFrequency'
  | 'partitionsIn'
  | 'readFrozenSource'
  | 'readMergeSegment'
  | 'readStoredFields'
  | 'regionsOverlap'
  | 'requireMatchingCursor'
  | 'requireRoom'
  | 'requireSegment'
  | 'requireWithinResultWindow'
  | 'resolveProjection'
  | 'SegmentRefusal'
  | 'SORT_COLUMN_MINIMUM_REBUILD_THRESHOLD'
  | 'SORT_COLUMN_REBUILD_FRACTION_SHIFT'
  | 'SORT_MODES'
  | 'SORT_VALUE_MAX_CODE_POINTS'
  | 'sortedPageOf'
  | 'sortModesOf'
  | 'sortSignatureOf'
  | 'storedText'
  | 'storedValuesOf'
  | 'subMatchesView'
  | 'termCount'
  | 'termText'
  | 'toComparableSortValue'
  | 'tokenize'
  | 'truncateSortString'
  | 'turnIsSpent'
  | 'typedRegion'
  | 'undeclaredFieldOnStrictIndex'
  | 'validQueryFilter'
  | 'validStoredValue'
  | 'VECTOR_PATTERN'
  | 'withSortableOption'
  | 'yieldTurn'
>

export let bitsetClear: OptionalReadsHost['bitsetClear']
export let bitsetFromSet: OptionalReadsHost['bitsetFromSet']
export let bitsetSet: OptionalReadsHost['bitsetSet']
export let buildStoredValues: OptionalReadsHost['buildStoredValues']
export let captureFrozen: OptionalReadsHost['captureFrozen']
export let captureSegment: OptionalReadsHost['captureSegment']
export let checkedSize: OptionalReadsHost['checkedSize']
export let clampLimit: OptionalReadsHost['clampLimit']
export let clampRowCount: OptionalReadsHost['clampRowCount']
export let codePointCount: OptionalReadsHost['codePointCount']
export let compareCodePoints: OptionalReadsHost['compareCodePoints']
export let compareScores: OptionalReadsHost['compareScores']
export let createBitSet: OptionalReadsHost['createBitSet']
export let createPatternWorkMeter: OptionalReadsHost['createPatternWorkMeter']
export let decodePageCursor: OptionalReadsHost['decodePageCursor']
export let DEFAULT_MAX_PER_GROUP: OptionalReadsHost['DEFAULT_MAX_PER_GROUP']
export let DEFAULT_SUGGEST_LIMIT: OptionalReadsHost['DEFAULT_SUGGEST_LIMIT']
export let defaultSortMode: OptionalReadsHost['defaultSortMode']
export let encodePageCursor: OptionalReadsHost['encodePageCursor']
export let ErrorCodes: OptionalReadsHost['ErrorCodes']
export let everyValueFacetConfig: OptionalReadsHost['everyValueFacetConfig']
export let expansionSource: OptionalReadsHost['expansionSource']
export let flattenSchema: OptionalReadsHost['flattenSchema']
export let fulltextMatches: OptionalReadsHost['fulltextMatches']
export let getFlatSchema: OptionalReadsHost['getFlatSchema']
export let isGeopointOrVectorType: OptionalReadsHost['isGeopointOrVectorType']
export let isListBase: OptionalReadsHost['isListBase']
export let isSortMode: OptionalReadsHost['isSortMode']
export let isStringValuedBase: OptionalReadsHost['isStringValuedBase']
export let keptFacetValues: OptionalReadsHost['keptFacetValues']
export let listBindingOf: OptionalReadsHost['listBindingOf']
export let liveFrequency: OptionalReadsHost['liveFrequency']
export let loadSuggestions: OptionalReadsHost['loadSuggestions']
export let lookupExact: OptionalReadsHost['lookupExact']
export let lookupPrefix: OptionalReadsHost['lookupPrefix']
export let lowerBound: OptionalReadsHost['lowerBound']
export let MAX_SUGGEST_LIMIT: OptionalReadsHost['MAX_SUGGEST_LIMIT']
export let MAX_SUGGEST_SCATTER_LIMIT: OptionalReadsHost['MAX_SUGGEST_SCATTER_LIMIT']
export let mergeFacets: OptionalReadsHost['mergeFacets']
export let mergeText: OptionalReadsHost['mergeText']
export let NarsilError: OptionalReadsHost['NarsilError']
export type NarsilError = InstanceType<OptionalReadsHost['NarsilError']>
export let normalizeSort: OptionalReadsHost['normalizeSort']
export let now: OptionalReadsHost['now']
export let parsedTypeOf: OptionalReadsHost['parsedTypeOf']
export let partitionDocumentFrequency: OptionalReadsHost['partitionDocumentFrequency']
export let partitionsIn: OptionalReadsHost['partitionsIn']
export let readFrozenSource: OptionalReadsHost['readFrozenSource']
export let readMergeSegment: OptionalReadsHost['readMergeSegment']
export let readStoredFields: OptionalReadsHost['readStoredFields']
export let regionsOverlap: OptionalReadsHost['regionsOverlap']
export let requireMatchingCursor: OptionalReadsHost['requireMatchingCursor']
export let requireRoom: OptionalReadsHost['requireRoom']
export let requireSegment: OptionalReadsHost['requireSegment']
export let requireWithinResultWindow: OptionalReadsHost['requireWithinResultWindow']
export let resolveProjection: OptionalReadsHost['resolveProjection']
export let SegmentRefusal: OptionalReadsHost['SegmentRefusal']
export type SegmentRefusal = InstanceType<OptionalReadsHost['SegmentRefusal']>
export let SORT_COLUMN_MINIMUM_REBUILD_THRESHOLD: OptionalReadsHost['SORT_COLUMN_MINIMUM_REBUILD_THRESHOLD']
export let SORT_COLUMN_REBUILD_FRACTION_SHIFT: OptionalReadsHost['SORT_COLUMN_REBUILD_FRACTION_SHIFT']
export let SORT_MODES: OptionalReadsHost['SORT_MODES']
export let SORT_VALUE_MAX_CODE_POINTS: OptionalReadsHost['SORT_VALUE_MAX_CODE_POINTS']
export let sortedPageOf: OptionalReadsHost['sortedPageOf']
export let sortModesOf: OptionalReadsHost['sortModesOf']
export let sortSignatureOf: OptionalReadsHost['sortSignatureOf']
export let storedText: OptionalReadsHost['storedText']
export let storedValuesOf: OptionalReadsHost['storedValuesOf']
export let subMatchesView: OptionalReadsHost['subMatchesView']
export let termCount: OptionalReadsHost['termCount']
export let termText: OptionalReadsHost['termText']
export let toComparableSortValue: OptionalReadsHost['toComparableSortValue']
export let tokenize: OptionalReadsHost['tokenize']
export let truncateSortString: OptionalReadsHost['truncateSortString']
export let turnIsSpent: OptionalReadsHost['turnIsSpent']
export let typedRegion: OptionalReadsHost['typedRegion']
export let undeclaredFieldOnStrictIndex: OptionalReadsHost['undeclaredFieldOnStrictIndex']
export let validQueryFilter: OptionalReadsHost['validQueryFilter']
export let validStoredValue: OptionalReadsHost['validStoredValue']
export let VECTOR_PATTERN: OptionalReadsHost['VECTOR_PATTERN']
export let withSortableOption: OptionalReadsHost['withSortableOption']
export let yieldTurn: OptionalReadsHost['yieldTurn']

export function bindOptionalReadsHost(host: OptionalReadsHost): void {
  ;({
    bitsetClear,
    bitsetFromSet,
    bitsetSet,
    buildStoredValues,
    captureFrozen,
    captureSegment,
    checkedSize,
    clampLimit,
    clampRowCount,
    codePointCount,
    compareCodePoints,
    compareScores,
    createBitSet,
    createPatternWorkMeter,
    decodePageCursor,
    DEFAULT_MAX_PER_GROUP,
    DEFAULT_SUGGEST_LIMIT,
    defaultSortMode,
    encodePageCursor,
    ErrorCodes,
    everyValueFacetConfig,
    expansionSource,
    flattenSchema,
    fulltextMatches,
    getFlatSchema,
    isGeopointOrVectorType,
    isListBase,
    isSortMode,
    isStringValuedBase,
    keptFacetValues,
    listBindingOf,
    liveFrequency,
    loadSuggestions,
    lookupExact,
    lookupPrefix,
    lowerBound,
    MAX_SUGGEST_LIMIT,
    MAX_SUGGEST_SCATTER_LIMIT,
    mergeFacets,
    mergeText,
    NarsilError,
    normalizeSort,
    now,
    parsedTypeOf,
    partitionDocumentFrequency,
    partitionsIn,
    readFrozenSource,
    readMergeSegment,
    readStoredFields,
    regionsOverlap,
    requireMatchingCursor,
    requireRoom,
    requireSegment,
    requireWithinResultWindow,
    resolveProjection,
    SegmentRefusal,
    SORT_COLUMN_MINIMUM_REBUILD_THRESHOLD,
    SORT_COLUMN_REBUILD_FRACTION_SHIFT,
    SORT_MODES,
    SORT_VALUE_MAX_CODE_POINTS,
    sortedPageOf,
    sortModesOf,
    sortSignatureOf,
    storedText,
    storedValuesOf,
    subMatchesView,
    termCount,
    termText,
    toComparableSortValue,
    tokenize,
    truncateSortString,
    turnIsSpent,
    typedRegion,
    undeclaredFieldOnStrictIndex,
    validQueryFilter,
    validStoredValue,
    VECTOR_PATTERN,
    withSortableOption,
    yieldTurn,
  } = host)
}
