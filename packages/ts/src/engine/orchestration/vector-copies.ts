import type { HostedVectorCopy, SharedCopyHost } from '../../vector/vector-index/shared'
import { createRequestId } from '../../workers/protocol'
import { awaitWritesApplied, replicateToWorkers } from './replication'
import type { OrchestratorState } from './types'

function holdsIndex(state: OrchestratorState, indexName: string): boolean {
  return state.scaledOutIndexes.has(indexName) || state.copyLoadBuffers.has(indexName)
}

export function sharedCopyHostOf(state: OrchestratorState): SharedCopyHost {
  return {
    get scratchSlotCount() {
      return state.workerPool?.workerCount ?? state.keywordWorkerCount
    },
    holdsIndex: (indexName: string) => holdsIndex(state, indexName),
    resolvePartition: (indexName: string, docId: string) => state.executor.getManager(indexName)?.partitionIdOf(docId),
    async loadShared(indexName: string, fieldName: string, handle: string, copy: HostedVectorCopy): Promise<boolean> {
      if (!holdsIndex(state, indexName)) return false
      await replicateToWorkers(state, {
        type: 'loadVectorCopy',
        indexName,
        fieldName,
        handle,
        copy,
        requestId: createRequestId(),
      })
      await awaitWritesApplied(state, indexName)
      return state.scaledOutIndexes.has(indexName)
    },
    async drop(indexName: string, fieldName: string, handle: string): Promise<void> {
      if (!holdsIndex(state, indexName)) return
      await replicateToWorkers(state, {
        type: 'dropVectorCopy',
        indexName,
        fieldName,
        handle,
        requestId: createRequestId(),
      })
    },
  }
}

export function refreshVectorCopies(state: OrchestratorState, indexName: string): void {
  if (state.vectorCopyPolicy?.host === undefined) return
  const manager = state.executor.getManager(indexName)
  if (manager === undefined) return
  for (const vectorIndex of manager.getVectorIndexes().values()) vectorIndex.refreshWorkerCopies()
}
