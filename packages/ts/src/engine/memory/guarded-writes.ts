import type { BatchResult } from '../../types/results'
import type { AnyDocument, InsertOptions, WriteOptions } from '../../types/schema'
import type { EngineCore } from '../core'
import { dropEngineIndex as dropIndexUnguarded } from '../index-lifecycle'
import {
  insertDocumentBatch as insertBatchUnguarded,
  insertDocument as insertUnguarded,
  type MutationContext,
  removeDocumentBatch as removeBatchUnguarded,
  removeDocument as removeUnguarded,
  updateDocumentBatch as updateBatchUnguarded,
  updateDocument as updateUnguarded,
} from '../mutations'
import { providedDocId } from '../mutations/insert-admission'
import type { MemoryGroupedItem } from './grouped-writes'
import type { MemoryWriteBlock, MemoryWriteGrouping } from './write-block-types'

type UpdateEntry = { docId: string; document: AnyDocument }

interface UpdateItem extends MemoryGroupedItem {
  update: UpdateEntry
}

const EMPTY_DOCUMENT: AnyDocument = {}

function blockFor(ctx: MutationContext, indexName: string): MemoryWriteBlock | undefined {
  const block = ctx.memoryWriteBlock
  if (block === undefined) return undefined
  ctx.guardShutdown()
  ctx.requireIndex(indexName)
  return block
}

async function withReservation<T>(
  grouping: MemoryWriteGrouping | undefined,
  indexName: string,
  document: AnyDocument,
  write: () => Promise<T>,
): Promise<T> {
  if (grouping === undefined) return write()
  const reservation = grouping.reserveFor(indexName, document)
  try {
    return await write()
  } finally {
    reservation.release()
  }
}

async function writeInGroups<T extends MemoryGroupedItem>(
  grouping: MemoryWriteGrouping,
  indexName: string,
  items: T[],
  write: (group: T[]) => Promise<BatchResult>,
): Promise<BatchResult> {
  const succeeded: string[] = []
  const failed: BatchResult['failed'] = []
  await grouping.applyInGroups(indexName, {
    items,
    failed,
    apply: async group => {
      const result = await write(group)
      for (const docId of result.succeeded) succeeded.push(docId)
      for (const failure of result.failed) failed.push(failure)
    },
  })
  return { succeeded, failed }
}

function updateItemOf(update: UpdateEntry): UpdateItem {
  const entry: unknown = update
  if (entry === null || typeof entry !== 'object') return { docId: '', document: EMPTY_DOCUMENT, update }
  const { docId, document } = entry as { docId?: unknown; document?: unknown }
  return {
    docId: typeof docId === 'string' ? docId : '',
    document: document !== null && typeof document === 'object' ? (document as AnyDocument) : EMPTY_DOCUMENT,
    update,
  }
}

export async function insertDocument(
  ctx: MutationContext,
  indexName: string,
  document: AnyDocument,
  docId?: string,
  options?: InsertOptions,
): Promise<string> {
  const block = blockFor(ctx, indexName)
  if (block === undefined) return insertUnguarded(ctx, indexName, document, docId, options)
  block.refuseWhileFull(indexName)
  return withReservation(block.grouping, indexName, document, () =>
    insertUnguarded(ctx, indexName, document, docId, options),
  )
}

export async function insertDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  documents: AnyDocument[],
  options?: InsertOptions,
): Promise<BatchResult> {
  const block = blockFor(ctx, indexName)
  if (block === undefined) return insertBatchUnguarded(ctx, indexName, documents, options)
  block.refuseWhileFull(indexName)
  const grouping = block.grouping
  if (grouping === undefined || documents.length === 0) {
    return insertBatchUnguarded(ctx, indexName, documents, options)
  }
  const items = documents.map(document => ({ docId: providedDocId(document) ?? '', document }))
  return writeInGroups(grouping, indexName, items, group =>
    insertBatchUnguarded(
      ctx,
      indexName,
      group.map(item => item.document),
      options,
    ),
  )
}

export async function updateDocument(
  ctx: MutationContext,
  indexName: string,
  docId: string,
  document: AnyDocument,
  options?: WriteOptions,
): Promise<void> {
  const block = blockFor(ctx, indexName)
  if (block === undefined) return updateUnguarded(ctx, indexName, docId, document, options)
  block.refuseWhileFull(indexName)
  return withReservation(block.grouping, indexName, document, () =>
    updateUnguarded(ctx, indexName, docId, document, options),
  )
}

export async function updateDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  updates: UpdateEntry[],
  options?: WriteOptions,
): Promise<BatchResult> {
  const block = blockFor(ctx, indexName)
  if (block === undefined) return updateBatchUnguarded(ctx, indexName, updates, options)
  block.refuseWhileFull(indexName)
  const grouping = block.grouping
  if (grouping === undefined || updates.length === 0) {
    return updateBatchUnguarded(ctx, indexName, updates, options)
  }
  return writeInGroups(grouping, indexName, updates.map(updateItemOf), group =>
    updateBatchUnguarded(
      ctx,
      indexName,
      group.map(item => item.update),
      options,
    ),
  )
}

export async function removeDocument(
  ctx: MutationContext,
  indexName: string,
  docId: string,
  options?: WriteOptions,
): Promise<void> {
  await removeUnguarded(ctx, indexName, docId, options)
  ctx.memoryWriteBlock?.memoryReleased()
}

export async function removeDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  docIds: string[],
  options?: WriteOptions,
): Promise<BatchResult> {
  const result = await removeBatchUnguarded(ctx, indexName, docIds, options)
  if (result.succeeded.length > 0) ctx.memoryWriteBlock?.memoryReleased()
  return result
}

export async function dropEngineIndex(core: EngineCore, name: string): Promise<void> {
  await dropIndexUnguarded(core, name)
  core.mutationCtx.memoryWriteBlock?.memoryReleased()
}
