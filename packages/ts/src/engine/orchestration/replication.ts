import type { WorkerAction } from '../../workers/protocol'
import { alreadyPresentOnWorker } from './eligibility'
import type { OrchestratorState, ReplicationQueue, SegmentLedgerEntry } from './types'

export const MAX_PENDING_REPLICATION_DOCUMENTS = 20_000

export async function dispatchToWorkers(state: OrchestratorState, action: WorkerAction): Promise<void> {
  const pool = state.workerPool
  if (!pool) return
  if ('indexName' in action && !state.scaledOutIndexes.has(action.indexName)) return

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
  if (action.type === 'swapSegments') {
    return action.snapshot.documentCount
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

function partitionLedger(state: OrchestratorState, indexName: string, partitionId: number): SegmentLedgerEntry[] {
  let byPartition = state.segmentLedger.get(indexName)
  if (byPartition === undefined) {
    byPartition = new Map()
    state.segmentLedger.set(indexName, byPartition)
  }
  let entries = byPartition.get(partitionId)
  if (entries === undefined) {
    entries = []
    byPartition.set(partitionId, entries)
  }
  return entries
}

function recordSegmentBroadcast(state: OrchestratorState, action: WorkerAction): void {
  if (action.type === 'attachSegments') {
    for (const segment of action.segments) {
      partitionLedger(state, action.indexName, segment.partitionId).push({
        segmentId: segment.snapshot.segmentId,
        documentCount: segment.snapshot.documentCount,
      })
    }
    return
  }
  if (action.type === 'swapSegments') {
    const entries = partitionLedger(state, action.indexName, action.partitionId)
    const dropped = new Set(action.dropSegmentIds)
    const kept = entries.filter(entry => !dropped.has(entry.segmentId))
    kept.push({ segmentId: action.snapshot.segmentId, documentCount: action.snapshot.documentCount })
    entries.length = 0
    entries.push(...kept)
  }
}

function queueFor(state: OrchestratorState, indexName: string): ReplicationQueue {
  let queue = state.replicationQueues.get(indexName)
  if (queue === undefined) {
    queue = { tail: Promise.resolve(), pendingActions: 0, pendingDocuments: 0 }
    state.replicationQueues.set(indexName, queue)
  }
  return queue
}

export function enqueueReplication(state: OrchestratorState, indexName: string, action: WorkerAction): void {
  const weight = documentWeight(action)
  recordSegmentBroadcast(state, action)
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
  if (!('indexName' in action)) {
    if (state.workerPool === null) return
    await awaitReplicationIdle(state)
    await dispatchToWorkers(state, action)
    return
  }

  const loading = state.copyLoadBuffers.get(action.indexName)
  if (loading !== undefined) {
    loading.push(detachCallerDocuments(action))
    return
  }
  if (state.workerPool === null || !state.scaledOutIndexes.has(action.indexName)) return

  const indexName = action.indexName
  const detached = detachCallerDocuments(action)
  const queue = state.replicationQueues.get(indexName)
  if (queue !== undefined && queue.pendingDocuments + documentWeight(detached) > MAX_PENDING_REPLICATION_DOCUMENTS) {
    await queue.tail
  }
  enqueueReplication(state, indexName, detached)
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
