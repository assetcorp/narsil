import {
  changeIndexOutsideExternalWaits,
  ErrorCodes,
  NarsilError,
  prepareDocumentVectors,
  removeDocumentVectors,
} from '#platform/optional-writes-host'
import type { RemovedSpellings } from '../../core/partition/frozen/surface-slot'
import type { PreparedTextChange } from '../../core/partition/prepared-text'
import type { AnyDocument } from '../../types/schema'
import type { VectorIndex } from '../../vector/vector-index'
import type { MutationContext } from './context'

export function holdVectorsForRollback(indexes: ReadonlyMap<string, VectorIndex>, docId: string): () => void {
  const releases: Array<() => void> = []
  for (const index of indexes.values()) releases.push(index.holdForRollback(docId))
  return () => {
    for (const release of releases) release()
  }
}

function restoreDocumentVectors(
  docId: string,
  vectors: ReadonlyMap<string, Float32Array>,
  indexes: ReadonlyMap<string, VectorIndex>,
  partitionId: number | undefined,
): void {
  for (const [fieldPath, index] of indexes) {
    const vector = vectors.get(fieldPath)
    if (vector !== undefined) index.restore(docId, vector, partitionId)
    else if (index.has(docId)) index.remove(docId)
  }
}

function rollbackFailed(docId: string, originalError: unknown, rollbackError: unknown): never {
  throw new NarsilError(
    ErrorCodes.REPLICATION_ROLLBACK_FAILED,
    `Durable write failed for document "${docId}" and the in-memory rollback also failed; the partition may expose an unacknowledged mutation`,
    {
      docId,
      originalError: originalError instanceof Error ? originalError.message : String(originalError),
      rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
    },
  )
}

export async function rollbackInsertedDocument(
  ctx: MutationContext,
  indexName: string,
  docId: string,
  inserted: boolean,
  originalError: unknown,
  preparedText?: PreparedTextChange,
  appliedRef?: AnyDocument,
  removedSpellings?: RemovedSpellings,
): Promise<void> {
  if (!inserted) {
    return
  }
  try {
    const manager = ctx.requireManager(indexName)
    await manager.publication.write(() =>
      changeIndexOutsideExternalWaits(async () => {
        if (appliedRef !== undefined && manager.getRef(docId) !== appliedRef) return
        manager.remove(docId, removedSpellings, { preparedText: { before: preparedText?.after } })
        removeDocumentVectors(docId, manager.getVectorIndexes())
        ctx.orchestrator.publishToWorkers({
          type: 'remove',
          indexName,
          docId,
          removedSpellings,
          requestId: `rollback-${docId}`,
        })
      }),
    )
  } catch (rollbackError) {
    rollbackFailed(docId, originalError, rollbackError)
  }
}

export async function rollbackRemovedDocument(
  ctx: MutationContext,
  indexName: string,
  docId: string,
  restoreDoc: AnyDocument | undefined,
  originalError: unknown,
  preparedText?: PreparedTextChange,
): Promise<void> {
  if (restoreDoc === undefined) {
    return
  }
  const manager = ctx.requireManager(indexName)
  try {
    await manager.publication.write(() =>
      changeIndexOutsideExternalWaits(async () => {
        if (manager.has(docId)) return
        const previous = prepareDocumentVectors(restoreDoc, ctx.requireIndex(indexName).vectorFieldPaths)
        manager.insert(docId, previous.partitionDoc, {
          preparedText: { after: preparedText?.before },
        })
        restoreDocumentVectors(
          docId,
          previous.extractedVectors,
          manager.getVectorIndexes(),
          manager.partitionIdOf(docId),
        )
        ctx.orchestrator.publishToWorkers({
          type: 'insert',
          indexName,
          docId,
          document: previous.partitionDoc,
          requestId: `rollback-${docId}`,
        })
      }),
    )
  } catch (rollbackError) {
    rollbackFailed(docId, originalError, rollbackError)
  }
}

export async function rollbackUpdatedDocument(
  ctx: MutationContext,
  indexName: string,
  docId: string,
  restoreDoc: AnyDocument | undefined,
  originalError: unknown,
  preparedText?: PreparedTextChange,
  appliedRef?: AnyDocument,
  rollbackRef?: AnyDocument,
): Promise<void> {
  if (restoreDoc === undefined || appliedRef === undefined) {
    return
  }
  try {
    const manager = ctx.requireManager(indexName)
    await manager.publication.write(() =>
      changeIndexOutsideExternalWaits(async () => {
        if (manager.getRef(docId) !== appliedRef) return
        const fields = ctx.requireIndex(indexName).vectorFieldPaths
        const previous = prepareDocumentVectors(restoreDoc, fields)
        manager.update(docId, rollbackRef ?? previous.partitionDoc, {
          skipClone: rollbackRef !== undefined,
          preparedText: { before: preparedText?.after, after: preparedText?.before },
        })
        restoreDocumentVectors(
          docId,
          previous.extractedVectors,
          manager.getVectorIndexes(),
          manager.partitionIdOf(docId),
        )
        ctx.orchestrator.publishToWorkers({
          type: 'update',
          indexName,
          docId,
          document: previous.partitionDoc,
          requestId: `rollback-${docId}`,
        })
      }),
    )
  } catch (rollbackError) {
    rollbackFailed(docId, originalError, rollbackError)
  }
}
