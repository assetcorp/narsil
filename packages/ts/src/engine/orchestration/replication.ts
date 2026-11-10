import {
  alreadyPresentOnWorker,
  LOAD_BUFFER_YIELD_INTERVAL,
  MAX_PENDING_REPLICATION_DOCUMENTS,
  prepareDocumentVectors,
  REPLICATION_WINDOW,
  toError,
  yieldToEventLoop,
} from '#platform/worker-copies-host'
import type { AnyDocument } from '../../types/schema'
import { executeRetained } from '../../workers/executor'
import type { WorkerAction } from '../../workers/protocol'
import { releasePublicationOf, retainPublicationOf } from './publication-code'
import type { CopyTransition, OrchestratorState, ReplicationQueue, ReplicationRun, SegmentLedgerEntry } from './types'

export async function dispatchToWorkers(state: OrchestratorState, action: WorkerAction): Promise<void> {
  const pool = state.workerPool
  if (!pool) return
  const executors = 'indexName' in action ? pool.executorsHolding(action.indexName) : pool.getAllExecutors()
  if ('indexName' in action && !state.scaledOutIndexes.has(action.indexName)) return

  const results = await Promise.allSettled(
    executors.map(workerExecutor => {
      const release = retainPublicationOf(action)
      return release === undefined ? workerExecutor.execute(action) : executeRetained(workerExecutor, action, release)
    }),
  )

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'rejected') {
      if (action.publication === undefined && action.type === 'insert' && alreadyPresentOnWorker(result.reason)) {
        continue
      }
      if (action.publication !== undefined) pool.retire(executors[i], toError(result.reason))
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
    let total = 0
    for (const snapshot of action.snapshots) total += snapshot.documentCount
    return total
  }
  return 1
}

const NO_VECTOR_FIELDS: ReadonlySet<string> = new Set()

function vectorFieldPathsOf(state: OrchestratorState, indexName: string): ReadonlySet<string> {
  return state.indexRegistry.get(indexName)?.vectorFieldPaths ?? NO_VECTOR_FIELDS
}

function withoutVectors(document: AnyDocument, fieldPaths: ReadonlySet<string>): AnyDocument {
  if (fieldPaths.size === 0) return document
  return prepareDocumentVectors(document as Record<string, unknown>, fieldPaths).partitionDoc as AnyDocument
}

export function detachCallerDocuments(state: OrchestratorState, action: WorkerAction): WorkerAction {
  if (action.type !== 'insert' && action.type !== 'update' && action.type !== 'mergeSegments') return action
  const fieldPaths = vectorFieldPathsOf(state, action.indexName)
  if (action.type === 'insert') {
    const stripped = withoutVectors(action.document, fieldPaths)
    const document = action.skipClone === true || stripped !== action.document ? stripped : structuredClone(stripped)
    return { ...action, document }
  }
  if (action.type === 'update') {
    const stripped = withoutVectors(action.document, fieldPaths)
    return { ...action, document: stripped !== action.document ? stripped : structuredClone(stripped) }
  }
  return {
    ...action,
    segments: action.segments.map(segment => {
      const documents = segment.documents.map(document => withoutVectors(document, fieldPaths))
      const cloned = action.skipClone === true || fieldPaths.size > 0 ? documents : structuredClone(documents)
      return { ...segment, documents: cloned }
    }),
  }
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
  if (action.type === 'clear') {
    state.segmentLedger.delete(action.indexName)
    return
  }
  if (action.type === 'attachSegments') {
    for (const segment of action.segments) {
      partitionLedger(state, action.indexName, segment.partitionId).push({
        segmentId: segment.snapshot.segmentId,
        documentCount: segment.snapshot.documentCount,
      })
    }
    return
  }
  if (action.type === 'freezeLiveTail') {
    partitionLedger(state, action.indexName, action.partitionId).push({
      segmentId: action.snapshot.segmentId,
      documentCount: action.snapshot.documentCount,
    })
    return
  }
  if (action.type === 'swapSegments') {
    const entries = partitionLedger(state, action.indexName, action.partitionId)
    const dropped = new Set(action.dropSegmentIds)
    const kept = entries.filter(entry => !dropped.has(entry.segmentId))
    for (const snapshot of action.snapshots) {
      kept.push({ segmentId: snapshot.segmentId, documentCount: snapshot.documentCount })
    }
    entries.length = 0
    entries.push(...kept)
  }
}

function queueFor(state: OrchestratorState, indexName: string): ReplicationQueue {
  let queue = state.replicationQueues.get(indexName)
  if (queue === undefined) {
    queue = {
      tail: Promise.resolve(),
      oldestRun: undefined,
      newestRun: undefined,
      runsInFlight: 0,
      pendingActions: 0,
      pendingDocuments: 0,
      drainWaiters: [],
    }
    state.replicationQueues.set(indexName, queue)
  }
  return queue
}

function dispatchGate(queue: ReplicationQueue): Promise<void> {
  if (queue.runsInFlight < REPLICATION_WINDOW) return Promise.resolve()
  let run = queue.newestRun
  for (let step = 1; step < REPLICATION_WINDOW && run !== undefined; step++) run = run.older
  return run?.done ?? Promise.resolve()
}

function appendRun(queue: ReplicationQueue, done: Promise<void>): ReplicationRun {
  const run: ReplicationRun = { done, older: queue.newestRun, newer: undefined }
  if (queue.newestRun === undefined) queue.oldestRun = run
  else queue.newestRun.newer = run
  queue.newestRun = run
  queue.runsInFlight += 1
  return run
}

function removeRun(queue: ReplicationQueue, run: ReplicationRun): void {
  if (run.older === undefined) queue.oldestRun = run.newer
  else run.older.newer = run.newer
  if (run.newer === undefined) queue.newestRun = run.older
  else run.newer.older = run.older
  run.older = undefined
  run.newer = undefined
  queue.runsInFlight -= 1
}

export function enqueueReplication(state: OrchestratorState, indexName: string, action: WorkerAction): void {
  const weight = documentWeight(action)
  recordSegmentBroadcast(state, action)
  const queue = queueFor(state, indexName)
  queue.pendingActions += 1
  queue.pendingDocuments += weight
  const gate = dispatchGate(queue)
  const entry = appendRun(queue, gate)
  const run: Promise<void> = gate.then(async () => {
    try {
      if (action.publication !== undefined) {
        const manager = state.executor.getManager(indexName)
        await manager?.publication.afterQueuedWrites()
        if (state.executor.getManager(indexName) !== manager) return
      }
      await dispatchToWorkers(state, action)
    } catch (err) {
      console.warn('Worker replication failed:', err)
    } finally {
      releasePublicationOf(action)
      removeRun(queue, entry)
      queue.pendingActions -= 1
      queue.pendingDocuments -= weight
      if (queue.pendingDocuments < MAX_PENDING_REPLICATION_DOCUMENTS && queue.drainWaiters.length > 0) {
        for (const resume of queue.drainWaiters.splice(0)) resume()
      }
      if (queue.pendingActions === 0 && state.replicationQueues.get(indexName) === queue) {
        state.replicationQueues.delete(indexName)
      }
    }
  })
  entry.done = run
  queue.tail = run
}

export function markCopiesLoaded(state: OrchestratorState, indexName: string, copyLoad: string): void {
  enqueueReplication(state, indexName, {
    type: 'copyLoaded',
    indexName,
    copyLoad,
    requestId: `copy-loaded-${copyLoad}`,
  })
}

function copiesWillReceive(state: OrchestratorState, indexName: string): boolean {
  if (state.copyLoadBuffers.has(indexName) || state.replicationQueues.has(indexName)) return true
  return state.workerPool !== null && state.scaledOutIndexes.has(indexName)
}

export async function replicateToWorkers(state: OrchestratorState, action: WorkerAction): Promise<void> {
  if (!('indexName' in action)) {
    if (state.workerPool === null) return
    await awaitReplicationIdle(state)
    await dispatchToWorkers(state, action)
    return
  }
  recordMainWrite(state, action)
  const waiting = replicationRoomWait(state, action.indexName)
  if (waiting !== null) await waiting
}

export function queueForCopies(state: OrchestratorState, action: WorkerAction): void {
  if (!('indexName' in action)) return
  const loading = state.copyLoadBuffers.get(action.indexName)
  if (loading !== undefined) {
    loading.push(action)
    return
  }
  if (state.workerPool === null || !state.scaledOutIndexes.has(action.indexName)) {
    releasePublicationOf(action)
    return
  }
  enqueueReplication(state, action.indexName, action)
}

function recordMainWrite(state: OrchestratorState, action: WorkerAction): void {
  if (!('indexName' in action) || !copiesWillReceive(state, action.indexName)) return
  queueForCopies(state, detachCallerDocuments(state, action))
}

function replicationRoomWait(state: OrchestratorState, indexName: string): Promise<void> | null {
  const loading = state.copyLoadBuffers.get(indexName)
  if (loading !== undefined) {
    const lastYield = state.copyLoadBufferYieldMarks.get(loading) ?? 0
    if (loading.length - lastYield < LOAD_BUFFER_YIELD_INTERVAL) return null
    state.copyLoadBufferYieldMarks.set(loading, loading.length)
    return yieldToEventLoop()
  }
  const queue = state.replicationQueues.get(indexName)
  if (queue === undefined || queue.pendingDocuments < MAX_PENDING_REPLICATION_DOCUMENTS) return null
  return new Promise<void>(resume => queue.drainWaiters.push(resume))
}

function settled(queue: ReplicationQueue): Promise<void> {
  const runs: Promise<void>[] = [queue.tail]
  for (let run = queue.oldestRun; run !== undefined; run = run.newer) runs.push(run.done)
  return Promise.all(runs).then(() => undefined)
}

export function publicationCapacityWait(state: OrchestratorState, indexName: string): Promise<void> | null {
  const waiting = replicationRoomWait(state, indexName)
  return waiting === null ? null : awaitPublicationCapacity(state, indexName, waiting)
}

async function awaitPublicationCapacity(
  state: OrchestratorState,
  indexName: string,
  first: Promise<void>,
): Promise<void> {
  await first
  for (;;) {
    const waiting = replicationRoomWait(state, indexName)
    if (waiting === null) return
    await waiting
  }
}

export async function awaitReplicationIdle(state: OrchestratorState, indexName?: string): Promise<void> {
  if (indexName !== undefined) {
    const queue = state.replicationQueues.get(indexName)
    if (queue !== undefined) await settled(queue)
    return
  }
  while (state.replicationQueues.size > 0) {
    await Promise.all(Array.from(state.replicationQueues.values(), settled))
  }
}

export async function awaitWritesApplied(state: OrchestratorState, indexName: string): Promise<void> {
  let awaitedTransition: CopyTransition | undefined
  let awaitedRepair: Promise<void> | null = null
  for (;;) {
    const transition = state.copyTransitions.get(indexName)
    if (transition !== undefined && transition !== awaitedTransition) {
      awaitedTransition = transition
      await transition.done
      continue
    }
    const repair = state.poolRepair
    if (repair !== null && repair !== awaitedRepair) {
      awaitedRepair = repair
      await repair
      continue
    }
    await awaitReplicationIdle(state, indexName)
    return
  }
}
