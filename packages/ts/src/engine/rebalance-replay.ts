import { ErrorCodes, NarsilError } from '../errors'
import type { PartitionManager } from '../partitioning/manager'
import type { WAQEntry, WriteAheadQueue } from '../partitioning/write-ahead-queue'
import type { AnyDocument } from '../types/schema'
import type { RebalanceContext } from './rebalance-executor'
import {
  deleteNestedValue,
  extractVectorFromDoc,
  insertDocumentVectors,
  prepareDocumentVectors,
  removeDocumentVectors,
  vectorsEqual,
} from './vector-coordinator'

export type ReplayFollowUp = () => Promise<void>

const NOTHING_TO_FOLLOW: ReplayFollowUp = async () => undefined

function warnHookError(hook: string, err: unknown): void {
  console.warn(`${hook} plugin hook error:`, err instanceof Error ? err.message : String(err))
}

function warnReplayFailure(entry: WAQEntry, err: unknown): void {
  const isMissing = err instanceof NarsilError && err.code === ErrorCodes.DOC_NOT_FOUND
  if (!isMissing) console.warn(`WAQ replay failed for ${entry.action} on doc "${entry.docId}":`, err)
}

function replayUpdateVectors(
  entry: WAQEntry,
  vectorFieldPaths: Set<string>,
): { updateDoc: AnyDocument; updateVectors: Map<string, Float32Array | null> } {
  const updateVectors = new Map<string, Float32Array | null>()
  for (const fieldPath of vectorFieldPaths) {
    updateVectors.set(fieldPath, extractVectorFromDoc(entry.document as Record<string, unknown>, fieldPath))
  }
  let updateDoc = entry.document as AnyDocument
  if (updateVectors.size > 0) {
    updateDoc = structuredClone(entry.document) as AnyDocument
    for (const fieldPath of updateVectors.keys()) {
      deleteNestedValue(updateDoc as Record<string, unknown>, fieldPath)
    }
  }
  return { updateDoc, updateVectors }
}

function applyInsert(
  manager: PartitionManager,
  indexName: string,
  entry: WAQEntry,
  document: AnyDocument,
  ctx: RebalanceContext,
): ReplayFollowUp {
  const vecIndexes = manager.getVectorIndexes()
  const { partitionDoc, extractedVectors } = prepareDocumentVectors(
    document as Record<string, unknown>,
    ctx.requireIndex(indexName).vectorFieldPaths,
  )
  const overwrote = manager.has(entry.docId)
  const removedSpellings = overwrote ? manager.removedSpellingsOf(entry.docId) : undefined
  if (overwrote) {
    removeDocumentVectors(entry.docId, vecIndexes)
    manager.remove(entry.docId, removedSpellings)
  }
  manager.insert(entry.docId, partitionDoc as AnyDocument)
  if (extractedVectors.size > 0) {
    insertDocumentVectors(entry.docId, extractedVectors, vecIndexes, manager.partitionIdOf(entry.docId))
    for (const fieldPath of extractedVectors.keys()) vecIndexes.get(fieldPath)?.scheduleBuild()
  }
  return async () => {
    try {
      await ctx.pluginRegistry.runHook('afterInsert', { indexName, docId: entry.docId, document })
    } catch (err) {
      warnHookError('afterInsert', err)
    }
    const replicated = { indexName, docId: entry.docId, document, requestId: `replicate-insert-${entry.docId}` }
    await ctx.orchestrator.replicateToWorkers(
      overwrote ? { type: 'update', ...replicated, removedSpellings } : { type: 'insert', ...replicated },
    )
  }
}

function applyRemove(
  manager: PartitionManager,
  indexName: string,
  entry: WAQEntry,
  ctx: RebalanceContext,
): ReplayFollowUp {
  const removedSpellings = manager.removedSpellingsOf(entry.docId)
  manager.remove(entry.docId, removedSpellings)
  removeDocumentVectors(entry.docId, manager.getVectorIndexes())
  return async () => {
    try {
      await ctx.pluginRegistry.runHook('afterRemove', { indexName, docId: entry.docId })
    } catch (err) {
      warnHookError('afterRemove', err)
    }
    await ctx.orchestrator.replicateToWorkers({
      type: 'remove',
      indexName,
      docId: entry.docId,
      requestId: `replicate-remove-${entry.docId}`,
      removedSpellings,
    })
  }
}

function applyUpdate(
  manager: PartitionManager,
  indexName: string,
  entry: WAQEntry,
  document: AnyDocument,
  ctx: RebalanceContext,
): ReplayFollowUp {
  const vecIndexes = manager.getVectorIndexes()
  const oldDocument = manager.get(entry.docId)
  const { updateDoc, updateVectors } = replayUpdateVectors(entry, ctx.requireIndex(indexName).vectorFieldPaths)
  const removedSpellings = manager.removedSpellingsOf(entry.docId)
  if (manager.has(entry.docId)) {
    manager.update(entry.docId, updateDoc, undefined, removedSpellings)
  } else {
    manager.insert(entry.docId, updateDoc)
  }
  for (const [fieldPath, newVec] of updateVectors) {
    const vecIndex = vecIndexes.get(fieldPath)
    if (!vecIndex) continue
    if (newVec === null) {
      if (vecIndex.has(entry.docId)) vecIndex.remove(entry.docId)
      continue
    }
    if (vectorsEqual(vecIndex.getVector(entry.docId), newVec)) continue
    if (vecIndex.has(entry.docId)) vecIndex.remove(entry.docId)
    vecIndex.insert(entry.docId, newVec)
    vecIndex.scheduleBuild()
  }
  return async () => {
    try {
      await ctx.pluginRegistry.runHook('afterUpdate', {
        indexName,
        docId: entry.docId,
        oldDocument: oldDocument ?? ({} as AnyDocument),
        newDocument: document,
      })
    } catch (err) {
      warnHookError('afterUpdate', err)
    }
    await ctx.orchestrator.replicateToWorkers({
      type: 'update',
      indexName,
      docId: entry.docId,
      document,
      requestId: `replicate-update-${entry.docId}`,
      removedSpellings,
    })
  }
}

function applyQueuedEntry(
  manager: PartitionManager,
  indexName: string,
  entry: WAQEntry,
  ctx: RebalanceContext,
): ReplayFollowUp {
  if (entry.action === 'insert' && entry.document) return applyInsert(manager, indexName, entry, entry.document, ctx)
  if (entry.action === 'remove') return applyRemove(manager, indexName, entry, ctx)
  if (entry.action === 'update' && entry.document) return applyUpdate(manager, indexName, entry, entry.document, ctx)
  return NOTHING_TO_FOLLOW
}

export interface QueuedFollowUp {
  entry: WAQEntry
  followUp: ReplayFollowUp
}

export function applyEveryQueuedWrite(
  manager: PartitionManager,
  indexName: string,
  waq: WriteAheadQueue,
  ctx: RebalanceContext,
): QueuedFollowUp[] {
  const followUps: QueuedFollowUp[] = []
  for (let entries = waq.drain(); entries.length > 0; entries = waq.drain()) {
    for (const entry of entries) {
      try {
        followUps.push({ entry, followUp: applyQueuedEntry(manager, indexName, entry, ctx) })
      } catch (err) {
        warnReplayFailure(entry, err)
      }
    }
  }
  return followUps
}

export async function runFollowUps(followUps: readonly QueuedFollowUp[]): Promise<void> {
  for (const { entry, followUp } of followUps) {
    try {
      await followUp()
    } catch (err) {
      warnReplayFailure(entry, err)
    }
  }
}

export async function replayQueued(
  manager: PartitionManager,
  indexName: string,
  waq: WriteAheadQueue,
  ctx: RebalanceContext,
): Promise<void> {
  for (let entries = waq.drain(); entries.length > 0; entries = waq.drain()) {
    for (const entry of entries) {
      let followUp: ReplayFollowUp
      try {
        followUp = applyQueuedEntry(manager, indexName, entry, ctx)
      } catch (err) {
        warnReplayFailure(entry, err)
        continue
      }
      await runFollowUps([{ entry, followUp }])
    }
  }
}
