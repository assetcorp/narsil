import type { OptionalCodeHost } from '../../engine/optional-code-host'

export type SegmentRemovalHost = Pick<
  OptionalCodeHost,
  | 'POSTING_LIST_COMPACTION_THRESHOLD'
  | 'SegmentRefusal'
  | 'acquireTokenPlan'
  | 'checkText'
  | 'prepareSpellingRemoval'
  | 'readSegmentRegions'
  | 'releaseSlice'
  | 'releaseTokenPlan'
  | 'removeString'
  | 'requireSegment'
  | 'rowRemoved'
  | 'tokenSources'
  | 'tokenTextOf'
  | 'trimClass'
  | 'trimSlice'
>

export let POSTING_LIST_COMPACTION_THRESHOLD: SegmentRemovalHost['POSTING_LIST_COMPACTION_THRESHOLD']
export let SegmentRefusal: SegmentRemovalHost['SegmentRefusal']
export let acquireTokenPlan: SegmentRemovalHost['acquireTokenPlan']
export let checkText: SegmentRemovalHost['checkText']
export let prepareSpellingRemoval: SegmentRemovalHost['prepareSpellingRemoval']
export let readSegmentRegions: SegmentRemovalHost['readSegmentRegions']
export let releaseSlice: SegmentRemovalHost['releaseSlice']
export let releaseTokenPlan: SegmentRemovalHost['releaseTokenPlan']
export let removeString: SegmentRemovalHost['removeString']
export let requireSegment: SegmentRemovalHost['requireSegment']
export let rowRemoved: SegmentRemovalHost['rowRemoved']
export let tokenSources: SegmentRemovalHost['tokenSources']
export let tokenTextOf: SegmentRemovalHost['tokenTextOf']
export let trimClass: SegmentRemovalHost['trimClass']
export let trimSlice: SegmentRemovalHost['trimSlice']

export function bindSegmentRemovalHost(host: SegmentRemovalHost): void {
  ;({
    POSTING_LIST_COMPACTION_THRESHOLD,
    SegmentRefusal,
    acquireTokenPlan,
    checkText,
    prepareSpellingRemoval,
    readSegmentRegions,
    releaseSlice,
    releaseTokenPlan,
    removeString,
    requireSegment,
    rowRemoved,
    tokenSources,
    tokenTextOf,
    trimClass,
    trimSlice,
  } = host)
}
