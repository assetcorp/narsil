import type { GraphInsertOutcome, SharedVectorFieldHandles } from '../../vector/shared-field/types'
import type { SharedCopyHost } from '../../vector/vector-index/shared'
import type { WorkerLease } from '../../workers/pool'
import { createRequestId } from '../../workers/protocol'
import { noteThreadSlotGone, threadSlotOfWorker } from '../../workers/thread-slot'
import { requireLoadedVectorCode } from '../../workers/vector-code'
import { awaitWritesApplied, replicateToWorkers } from './replication'
import type { OrchestratorState } from './types'

function holdsIndex(state: OrchestratorState, indexName: string): boolean {
  return state.scaledOutIndexes.has(indexName) || state.copyLoadBuffers.has(indexName)
}

async function insertOnLease(
  lease: WorkerLease,
  indexName: string,
  fieldName: string,
  handle: string,
  ordinals: Int32Array,
): Promise<GraphInsertOutcome | null> {
  try {
    const outcome = await lease.executor.execute<GraphInsertOutcome | null>({
      type: 'insertVectorOrdinals',
      indexName,
      fieldName,
      handle,
      ordinals,
      requestId: createRequestId(),
    })
    return outcome ?? null
  } catch {
    return null
  } finally {
    lease.release()
  }
}

export function sharedCopyHostOf(state: OrchestratorState): SharedCopyHost {
  return {
    get workerCount() {
      return state.workerPool?.workerCount ?? state.keywordWorkerCount + state.longQueryWorkerCount
    },
    holdsIndex: (indexName: string) => holdsIndex(state, indexName),
    resolvePartition: (indexName: string, docId: string) => state.executor.getManager(indexName)?.partitionIdOf(docId),
    async loadShared(
      indexName: string,
      fieldName: string,
      handle: string,
      handles: SharedVectorFieldHandles,
    ): Promise<boolean> {
      if (!holdsIndex(state, indexName)) return false
      state.sharedVectorFields.set(handle, handles)
      await replicateToWorkers(state, {
        type: 'loadVectorCopy',
        indexName,
        fieldName,
        handle,
        handles,
        requestId: createRequestId(),
      })
      await awaitWritesApplied(state, indexName)
      return state.scaledOutIndexes.has(indexName)
    },
    async drop(indexName: string, fieldName: string, handle: string): Promise<void> {
      state.sharedVectorFields.delete(handle)
      if (!holdsIndex(state, indexName)) return
      await replicateToWorkers(state, {
        type: 'dropVectorCopy',
        indexName,
        fieldName,
        handle,
        requestId: createRequestId(),
      })
    },
    async insertOrdinals(indexName, fieldName, handle, ordinals): Promise<GraphInsertOutcome | null> {
      const pool = state.workerPool
      if (pool === null || !state.scaledOutIndexes.has(indexName)) return null
      for (let attempt = 0; attempt < pool.workerCount; attempt++) {
        const lease = pool.leaseLeastBusy()
        if (lease === null) return null
        const outcome = await insertOnLease(lease, indexName, fieldName, handle, ordinals)
        if (outcome !== null) return outcome
        if (!state.scaledOutIndexes.has(indexName)) return null
      }
      return null
    },
  }
}

export function releaseVectorLocksOf(state: OrchestratorState, workerId: number): void {
  noteThreadSlotGone(threadSlotOfWorker(workerId))
  if (state.sharedVectorFields.size === 0) return
  const { releaseLocksHeldBy } = requireLoadedVectorCode()
  for (const handles of state.sharedVectorFields.values()) {
    if (handles.graph !== null) releaseLocksHeldBy(handles.graph, threadSlotOfWorker(workerId))
  }
}

export function refreshVectorCopies(state: OrchestratorState, indexName: string): void {
  if (state.vectorCopyPolicy?.host === undefined) return
  const manager = state.executor.getManager(indexName)
  if (manager === undefined) return
  for (const vectorIndex of manager.getVectorIndexes().values()) vectorIndex.refreshWorkerCopies()
}
