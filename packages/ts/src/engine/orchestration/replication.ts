import type { WorkerAction } from '../../workers/protocol'
import { alreadyPresentOnWorker, reportIneligible, workerIneligibility } from './eligibility'
import type { OrchestratorState, ReplicationQueue } from './types'

export const MAX_PENDING_REPLICATION_DOCUMENTS = 20_000

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

function documentWeight(action: WorkerAction): number {
  if (action.type === 'mergeSegments') {
    let total = 0
    for (const segment of action.segments) {
      total += segment.documents.length
    }
    return total
  }
  if (action.type === 'attachSegments') {
    let total = 0
    for (const segment of action.segments) {
      total += segment.snapshot.documentCount
    }
    return total
  }
  return 1
}

function detachCallerDocuments(action: WorkerAction): WorkerAction {
  if (action.type === 'insert' && action.skipClone !== true) {
    return { ...action, document: structuredClone(action.document) }
  }
  if (action.type === 'update') {
    return { ...action, document: structuredClone(action.document) }
  }
  if (action.type === 'mergeSegments' && action.skipClone !== true) {
    return {
      ...action,
      segments: action.segments.map(segment => ({ ...segment, documents: structuredClone(segment.documents) })),
    }
  }
  return action
}

function queueFor(state: OrchestratorState, indexName: string): ReplicationQueue {
  let queue = state.replicationQueues.get(indexName)
  if (queue === undefined) {
    queue = { tail: Promise.resolve(), pendingActions: 0, pendingDocuments: 0 }
    state.replicationQueues.set(indexName, queue)
  }
  return queue
}

function enqueue(state: OrchestratorState, indexName: string, action: WorkerAction, weight: number): void {
  const queue = queueFor(state, indexName)
  queue.pendingActions += 1
  queue.pendingDocuments += weight
  queue.tail = queue.tail.then(async () => {
    try {
      await dispatchToWorkers(state, action)
    } catch (err) {
      console.warn('Worker replication failed:', err)
    } finally {
      queue.pendingActions -= 1
      queue.pendingDocuments -= weight
      if (queue.pendingActions === 0 && state.replicationQueues.get(indexName) === queue) {
        state.replicationQueues.delete(indexName)
      }
    }
  })
}

export async function replicateToWorkers(state: OrchestratorState, action: WorkerAction): Promise<void> {
  if (state.promotionInProgress) {
    state.promotionBuffer.push(detachCallerDocuments(action))
    return
  }
  if (state.workerPool === null) return

  const detached = detachCallerDocuments(action)
  if (!('indexName' in detached)) {
    await awaitReplicationIdle(state)
    await dispatchToWorkers(state, detached)
    return
  }

  const weight = documentWeight(detached)
  const queue = state.replicationQueues.get(detached.indexName)
  if (queue !== undefined && queue.pendingDocuments + weight > MAX_PENDING_REPLICATION_DOCUMENTS) {
    await queue.tail
  }
  enqueue(state, detached.indexName, detached, weight)
}

export async function awaitReplicationIdle(state: OrchestratorState, indexName?: string): Promise<void> {
  if (indexName !== undefined) {
    const queue = state.replicationQueues.get(indexName)
    if (queue !== undefined) await queue.tail
    return
  }
  while (state.replicationQueues.size > 0) {
    const tails = Array.from(state.replicationQueues.values(), queue => queue.tail)
    await Promise.all(tails)
  }
}

export async function drainPromotionBuffer(state: OrchestratorState): Promise<void> {
  while (state.promotionBuffer.length > 0) {
    const action = state.promotionBuffer.shift()
    if (action === undefined) return
    await dispatchToWorkers(state, action)
  }
}
