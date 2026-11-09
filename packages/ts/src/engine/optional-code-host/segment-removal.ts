import { POSTING_LIST_COMPACTION_THRESHOLD } from '../../core/constants'
import { prepareSpellingRemoval } from '../../core/partition/partial-words/registry'
import { bindSegmentRemoval } from '../../core/segment-writes/bound-removal'
import { releaseSlice, trimClass, trimSlice } from '../../core/segment-writes/pools'
import { rowRemoved } from '../../core/segment-writes/postings'
import { checkText, readRetirementRegions, readSegmentRegions } from '../../core/segment-writes/regions'
import { removeString } from '../../core/segment-writes/strings'
import { preparedRemovalReach, preparedSources } from '../../core/segment-writes/token-sources'
import { acquireTokenPlan, releaseTokenPlan } from '../../core/segment-writes/tokens'

export function segmentRemovalHostPart() {
  return {
    POSTING_LIST_COMPACTION_THRESHOLD,
    acquireTokenPlan,
    bindSegmentRemoval,
    checkText,
    prepareSpellingRemoval,
    preparedRemovalReach,
    preparedSources,
    readRetirementRegions,
    readSegmentRegions,
    releaseSlice,
    releaseTokenPlan,
    removeString,
    rowRemoved,
    trimClass,
    trimSlice,
  }
}
