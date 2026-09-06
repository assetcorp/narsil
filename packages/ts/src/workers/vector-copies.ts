import type { PartitionManager } from '../partitioning/manager'
import { createSharedVectorSearcher } from '../vector/shared-generation/searcher'
import type { HostedVectorCopy, VectorSearcher } from '../vector/vector-index/shared'

/**
 * The frozen vector copies one worker holds for an index, keyed by field, with
 * the handle each arrived under so that a late withdrawal of an older copy
 * leaves a newer one in place.
 *
 * @internal
 */
export interface HeldVectorCopies {
  searchers: Map<string, VectorSearcher>
  handles: Map<string, string>
}

export function createHeldVectorCopies(): HeldVectorCopies {
  return { searchers: new Map(), handles: new Map() }
}

export function loadHeldVectorCopy(
  held: HeldVectorCopies,
  manager: PartitionManager,
  fieldName: string,
  handle: string,
  copy: HostedVectorCopy,
  scratchSlot: number,
): void {
  held.searchers.set(
    fieldName,
    createSharedVectorSearcher({
      fieldName,
      snapshot: copy.snapshot,
      scratchSlot,
      docIds: copy.docIds,
      filterThreshold: copy.filterThreshold,
      holdsDocument: docId => manager.has(docId),
    }),
  )
  held.handles.set(fieldName, handle)
}

export function dropHeldVectorCopy(held: HeldVectorCopies, fieldName: string, handle: string): void {
  if (held.handles.get(fieldName) !== handle) return
  held.searchers.delete(fieldName)
  held.handles.delete(fieldName)
}
