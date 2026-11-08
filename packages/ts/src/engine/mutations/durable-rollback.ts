import { changeIndexOutsideExternalWaits } from '#platform/turn-budget'
import type { RemovedSpellings } from '../../core/partition/frozen/surface-slot'
import type { PreparedTextChange } from '../../core/partition/prepared-text'
import { ErrorCodes, NarsilError } from '../../errors'
import type { AnyDocument } from '../../types/schema'
import {
  insertDocumentVectors,
  prepareDocumentVectors,
  removeDocumentVectors,
  updateDocumentVectors,
} from '../vector-coordinator'
import type { MutationContext } from './context'

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
        insertDocumentVectors(
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
        const vectors = new Map([...fields].map(field => [field, previous.extractedVectors.get(field) ?? null]))
        updateDocumentVectors(docId, vectors, manager.getVectorIndexes(), manager.partitionIdOf(docId))
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
