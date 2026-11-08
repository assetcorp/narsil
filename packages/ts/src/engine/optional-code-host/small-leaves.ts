import { removeDocumentBatch } from '#platform/memory-guarded-writes'
import { unionOfBans } from '../../query-suggestions/bans'
import { clearLeftoversOfName, installSuggestionHooks } from '../../query-suggestions/engine-hooks'
import { RestoredHistory } from '../../query-suggestions/restored-history'
import { withState } from '../../query-suggestions/stored-state'

export function smallLeavesHostPart() {
  return {
    RestoredHistory,
    clearLeftoversOfName,
    installSuggestionHooks,
    removeDocumentBatch,
    unionOfBans,
    withState,
  }
}
