import type { NativeCore } from '@delali/narsil'
import type { NarsilCore } from '../specs/core.nitro'
import { withNativeCode } from './native-error'

function methodOf(core: NarsilCore, name: string): (...parameters: unknown[]) => number {
  const method: unknown = Reflect.get(core, name)
  if (typeof method !== 'function') {
    return () => {
      throw new Error(`The native search core on this phone has no ${name} method.`)
    }
  }
  return (...parameters) => {
    let status: unknown
    try {
      status = Reflect.apply(method, core, parameters)
    } catch (error) {
      throw withNativeCode(error)
    }
    if (typeof status !== 'number') throw new Error(`The native search core returned no status from ${name}.`)
    return status
  }
}

export function adaptKeyword(
  core: NarsilCore,
): Pick<
  NativeCore,
  | 'keywordScore'
  | 'fuse'
  | 'mergeRankings'
  | 'mergeSorted'
  | 'placePinned'
  | 'mergeFacets'
  | 'mergeGroups'
  | 'groupHits'
  | 'pageStart'
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
  | 'clockNow'
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
  | 'prepareFrozenRemoval'
  | 'beginBatch'
  | 'endBatch'
  | 'measureMerge'
  | 'writeMerge'
  | 'mergePostings'
  | 'measureFieldMerge'
  | 'writeFieldMerge'
> {
  return {
    keywordScore: methodOf(core, 'keywordScore'),
    fuse: methodOf(core, 'fuse'),
    mergeRankings: methodOf(core, 'mergeRankings'),
    mergeSorted: methodOf(core, 'mergeSorted'),
    placePinned: methodOf(core, 'placePinned'),
    mergeFacets: methodOf(core, 'mergeFacets'),
    mergeGroups: methodOf(core, 'mergeGroups'),
    groupHits: methodOf(core, 'groupHits'),
    pageStart: methodOf(core, 'pageStart'),
    sortValue: methodOf(core, 'sortValue'),
    buildSortOrder: methodOf(core, 'buildSortOrder'),
    textRange: methodOf(core, 'textRange'),
    booleanFacet: methodOf(core, 'booleanFacet'),
    numberFacet: methodOf(core, 'numberFacet'),
    rangeFacet: methodOf(core, 'rangeFacet'),
    enumFacet: methodOf(core, 'enumFacet'),
    valueFacet: methodOf(core, 'valueFacet'),
    storedRangeFacet: methodOf(core, 'storedRangeFacet'),
    sortSelect: methodOf(core, 'sortSelect'),
    evaluateFilter: methodOf(core, 'evaluateFilter'),
    patternTest: methodOf(core, 'patternTest'),
    clockNow: methodOf(core, 'clockNow'),
    lookupExact: methodOf(core, 'lookupExact'),
    lookupExactBatch: methodOf(core, 'lookupExactBatch'),
    lookupPrefix: methodOf(core, 'lookupPrefix'),
    lookupTypo: methodOf(core, 'lookupTypo'),
    documentFrequency: methodOf(core, 'documentFrequency'),
    expandSynonyms: methodOf(core, 'expandSynonyms'),
    expandPrefix: methodOf(core, 'expandPrefix'),
    expandPartialWords: methodOf(core, 'expandPartialWords'),
    suggestTerms: methodOf(core, 'suggestTerms'),
    highlight: methodOf(core, 'highlight'),
    matchPhrases: methodOf(core, 'matchPhrases'),
    indexTerms: methodOf(core, 'indexTerms'),
    removeDocument: methodOf(core, 'removeDocument'),
    removeFrozenDocument: methodOf(core, 'removeFrozenDocument'),
    prepareFrozenRemoval: methodOf(core, 'prepareFrozenRemoval'),
    beginBatch: methodOf(core, 'beginBatch'),
    endBatch: methodOf(core, 'endBatch'),
    measureMerge: methodOf(core, 'measureMerge'),
    writeMerge: methodOf(core, 'writeMerge'),
    mergePostings: methodOf(core, 'mergePostings'),
    measureFieldMerge: methodOf(core, 'measureFieldMerge'),
    writeFieldMerge: methodOf(core, 'writeFieldMerge'),
  }
}
