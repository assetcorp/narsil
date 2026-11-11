import { type HeldCopyPublication, holdCopyPublication } from '../../workers/copy-publication'
import type { WorkerAction } from '../../workers/protocol'
import { trackPublicationStores } from './publication-stores'
import { detachCallerDocuments, queueForCopies } from './replication'
import type { OrchestratorState } from './types'

const heldPublications = new WeakMap<WorkerAction, HeldCopyPublication>()

export function retainPublicationOf(action: WorkerAction): (() => void) | undefined {
  return heldPublications.get(action)?.retain()
}

export function releasePublicationOf(action: WorkerAction): void {
  heldPublications.get(action)?.release()
  heldPublications.delete(action)
}

export function publishToWorkers(state: OrchestratorState, action: WorkerAction): Promise<void> | undefined {
  if (!('indexName' in action)) return
  if (!state.copyLoadBuffers.has(action.indexName) && !state.scaledOutIndexes.has(action.indexName)) return
  const manager = state.executor.getManager(action.indexName)
  if (manager === undefined) return
  if (!state.scaledOutIndexes.has(action.indexName)) {
    for (const vector of manager.getVectorIndexes().values()) {
      if (vector.maintenanceStatus().loadingFromFiles) return
    }
  }
  const detached = detachCallerDocuments(state, action)
  const held = holdCopyPublication(manager, true)
  const publication = { ...detached, publication: held.publication }
  heldPublications.set(publication, held)
  trackPublicationStores(state, held.publication)
  try {
    queueForCopies(state, publication)
  } catch (error) {
    releasePublicationOf(publication)
    throw error
  }
}
