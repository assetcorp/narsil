import type { WorkerAction } from '../../workers/protocol'
import { alreadyPresentOnWorker, reportIneligible, workerIneligibility } from './eligibility'
import type { OrchestratorState } from './types'

export async function dispatchToWorkers(state: OrchestratorState, action: WorkerAction): Promise<void> {
  const pool = state.workerPool
  if (!pool) return

  if (action.type === 'createIndex') {
    const ineligibility = workerIneligibility(action.indexName, action.config, state.bootstrapModule)
    if (ineligibility) {
      reportIneligible(state, action.indexName, ineligibility)
      return
    }
    pool.addIndexToAll(action.indexName)
    state.promotedIndexes.add(action.indexName)
  } else if ('indexName' in action && !state.promotedIndexes.has(action.indexName)) {
    return
  }

  const allExecutors = pool.getAllExecutors()
  const results = await Promise.allSettled(allExecutors.map(workerExecutor => workerExecutor.execute(action)))

  for (const result of results) {
    if (result.status === 'rejected') {
      if (action.type === 'insert' && alreadyPresentOnWorker(result.reason)) {
        continue
      }
      console.warn('Worker replication failed:', result.reason)
    }
  }
}

export async function replicateToWorkers(state: OrchestratorState, action: WorkerAction): Promise<void> {
  if (state.promotionInProgress) {
    state.promotionBuffer.push(action)
    return
  }
  await dispatchToWorkers(state, action)
}

export async function drainPromotionBuffer(state: OrchestratorState): Promise<void> {
  while (state.promotionBuffer.length > 0) {
    const action = state.promotionBuffer.shift()
    if (action === undefined) return
    await dispatchToWorkers(state, action)
  }
}
