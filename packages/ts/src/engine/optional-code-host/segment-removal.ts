import { POSTING_LIST_COMPACTION_THRESHOLD } from '../../core/constants'
import { holdsUnpairedSurrogate } from '../../core/ordering/code-points'
import { prepareSpellingRemoval } from '../../core/partition/partial-words/registry'
import { bindSegmentRemoval } from '../../core/segment-writes/bound-removal'
import { sharedTexts } from '../../core/segment-writes/document-publish'
import { releaseSlice, trimClass, trimSlice } from '../../core/segment-writes/pools'
import { rowRemoved } from '../../core/segment-writes/postings'
import { checkText, readSegmentView } from '../../core/segment-writes/regions'
import { findString, removeString, StringPlan, stringHash } from '../../core/segment-writes/strings'
import { preparedSources } from '../../core/segment-writes/token-sources'
import { acquireTokenPlan, releaseTokenPlan } from '../../core/segment-writes/tokens'

export function segmentRemovalHostPart() {
  return {
    POSTING_LIST_COMPACTION_THRESHOLD,
    StringPlan,
    acquireTokenPlan,
    bindSegmentRemoval,
    checkText,
    findString,
    holdsUnpairedSurrogate,
    prepareSpellingRemoval,
    preparedSources,
    readSegmentView,
    releaseSlice,
    releaseTokenPlan,
    removeString,
    rowRemoved,
    sharedTexts,
    stringHash,
    trimClass,
    trimSlice,
  }
}
