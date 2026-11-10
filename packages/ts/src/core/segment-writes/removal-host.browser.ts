import type { OptionalCodeHost } from '../../engine/optional-code-host'

export type SegmentRemovalHost = Pick<
  OptionalCodeHost,
  | 'POSTING_LIST_COMPACTION_THRESHOLD'
  | 'SegmentRefusal'
  | 'StringPlan'
  | 'acquireTokenPlan'
  | 'findString'
  | 'holdsUnpairedSurrogate'
  | 'prepareSpellingRemoval'
  | 'preparedSources'
  | 'readSegmentView'
  | 'releaseSlice'
  | 'releaseTokenPlan'
  | 'removeString'
  | 'requireSegment'
  | 'rowRemoved'
  | 'sharedTexts'
  | 'stringHash'
  | 'trimClass'
  | 'trimSlice'
>

export let POSTING_LIST_COMPACTION_THRESHOLD: SegmentRemovalHost['POSTING_LIST_COMPACTION_THRESHOLD']
export let SegmentRefusal: SegmentRemovalHost['SegmentRefusal']
export let StringPlan: SegmentRemovalHost['StringPlan']
export let acquireTokenPlan: SegmentRemovalHost['acquireTokenPlan']
export let findString: SegmentRemovalHost['findString']
export let holdsUnpairedSurrogate: SegmentRemovalHost['holdsUnpairedSurrogate']
export let prepareSpellingRemoval: SegmentRemovalHost['prepareSpellingRemoval']
export let preparedSources: SegmentRemovalHost['preparedSources']
export let readSegmentView: SegmentRemovalHost['readSegmentView']
export let releaseSlice: SegmentRemovalHost['releaseSlice']
export let releaseTokenPlan: SegmentRemovalHost['releaseTokenPlan']
export let removeString: SegmentRemovalHost['removeString']
export let requireSegment: SegmentRemovalHost['requireSegment']
export let rowRemoved: SegmentRemovalHost['rowRemoved']
export let sharedTexts: SegmentRemovalHost['sharedTexts']
export let stringHash: SegmentRemovalHost['stringHash']
export let trimClass: SegmentRemovalHost['trimClass']
export let trimSlice: SegmentRemovalHost['trimSlice']

export function bindSegmentRemovalHost(host: SegmentRemovalHost): void {
  ;({
    POSTING_LIST_COMPACTION_THRESHOLD,
    SegmentRefusal,
    StringPlan,
    acquireTokenPlan,
    findString,
    holdsUnpairedSurrogate,
    prepareSpellingRemoval,
    preparedSources,
    readSegmentView,
    releaseSlice,
    releaseTokenPlan,
    removeString,
    requireSegment,
    rowRemoved,
    sharedTexts,
    stringHash,
    trimClass,
    trimSlice,
  } = host)
}
