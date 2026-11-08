export type NativeOperation =
  | 'search'
  | 'score'
  | 'place'
  | 'remove'
  | 'compact'
  | 'connect'
  | 'measure'
  | 'quantise'
  | 'analyse'
  | 'keywordScore'
  | 'pageStart'
  | 'placePinned'
  | 'fuse'
  | 'mergeRankings'
  | 'mergeSorted'
  | 'mergeFacets'
  | 'mergeGroups'
  | 'groupHits'
  | 'sortValue'
  | 'buildSortOrder'
  | 'textRange'
  | 'booleanFacet'
  | 'numberFacet'
  | 'rangeFacet'
  | 'enumFacet'
  | 'valueFacet'
  | 'storedRangeFacet'
  | 'sortSelect'
  | 'evaluateFilter'
  | 'patternTest'
  | 'lookupExact'
  | 'lookupExactBatch'
  | 'lookupPrefix'
  | 'lookupTypo'
  | 'documentFrequency'
  | 'expandSynonyms'
  | 'expandPrefix'
  | 'expandPartialWords'
  | 'suggestTerms'
  | 'highlight'
  | 'matchPhrases'
  | 'indexTerms'
  | 'removeDocument'
  | 'removeFrozenDocument'
  | 'beginBatch'
  | 'endBatch'
  | 'measureMerge'
  | 'writeMerge'
  | 'mergePostings'
  | 'measureFieldMerge'
  | 'writeFieldMerge'

let nativeSearchCoreEnabled = true
let fallbackObserver: ((operation: NativeOperation) => void) | null = null

export function setNativeSearchCoreEnabled(enabled: boolean): void {
  nativeSearchCoreEnabled = enabled
}

export function nativeSearchCoreIsEnabled(): boolean {
  return nativeSearchCoreEnabled
}

export function stopUsingTheNativeSearchCore(error: unknown): void {
  if (!nativeSearchCoreEnabled) return
  nativeSearchCoreEnabled = false
  console.warn(
    'The native search core raised an error, so this thread searches through WebAssembly from now on:',
    error instanceof Error ? error.message : String(error),
  )
}

export function observeFallbacks(observer: ((operation: NativeOperation) => void) | null): void {
  fallbackObserver = observer
}

export function noteFallback(operation: NativeOperation): void {
  if (fallbackObserver !== null) fallbackObserver(operation)
}
