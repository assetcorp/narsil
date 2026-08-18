import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import { validateRequiredFields } from '../../schema/validator'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, EmbeddingFieldConfig, IndexConfig } from '../../types/schema'
import { assertDocumentCarriesMappedVectors, embedBatchDocumentFields } from '../embed'
import type { MutationContext } from './context'

/** Resolves a document's own `id` field as its identifier when present, so a
 * caller that embeds an id in the document (the cross-language convention) keeps
 * it. Returns undefined for an absent or non-string id, leaving the caller to
 * fall back to an explicit id argument or generation. */
export function providedDocId(document: AnyDocument): string | undefined {
  const id = (document as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

export function asBatchInsertError(err: unknown): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, String(err))
}

export function admitInsert(
  ctx: MutationContext,
  indexName: string,
  manager: PartitionManager,
  docId: string,
  pendingAdmitted = 0,
): void {
  if (!ctx.isRebalancing(indexName)) {
    manager.assertCapacity(pendingAdmitted)
    return
  }
  const bufferedState = ctx.bufferedDocState(indexName, docId)
  const exists = bufferedState !== undefined ? bufferedState === 'present' : manager.has(docId)
  if (exists) {
    throw new NarsilError(ErrorCodes.DOC_ALREADY_EXISTS, `Document "${docId}" already exists`, { docId })
  }
  manager.assertCapacity(
    ctx.pendingRebalanceWrites(indexName) + pendingAdmitted,
    ctx.rebalanceTargetPartitionCount(indexName),
  )
}

export function collectRequiredFieldFailures(
  documents: AnyDocument[],
  chunkStart: number,
  chunkEnd: number,
  required: string[],
  chunkFailedIndexes: Set<number>,
  failed: BatchResult['failed'],
): void {
  for (let i = chunkStart; i < chunkEnd; i++) {
    try {
      validateRequiredFields(documents[i] as Record<string, unknown>, required)
    } catch (err) {
      chunkFailedIndexes.add(i)
      failed.push({ docId: providedDocId(documents[i]) ?? '', error: asBatchInsertError(err) })
    }
  }
}

export interface EmbeddingChunkEntry {
  config: IndexConfig
  embeddingAdapter: EmbeddingAdapter | null
  embeddingAdapterName: string | null
}

export async function embedChunkDocuments(
  entry: EmbeddingChunkEntry,
  documents: AnyDocument[],
  chunkStart: number,
  chunkEnd: number,
  signal: AbortSignal,
  chunkFailedIndexes: Set<number>,
  failed: BatchResult['failed'],
): Promise<void> {
  if (entry.config.embedding === undefined) return

  if (entry.embeddingAdapter === null) {
    for (let i = chunkStart; i < chunkEnd; i++) {
      if (chunkFailedIndexes.has(i)) continue
      try {
        assertDocumentCarriesMappedVectors(
          documents[i] as Record<string, unknown>,
          entry.config.embedding as EmbeddingFieldConfig,
          entry.embeddingAdapterName,
        )
      } catch (err) {
        chunkFailedIndexes.add(i)
        failed.push({
          docId: providedDocId(documents[i]) ?? '',
          error: err instanceof NarsilError ? err : new NarsilError(ErrorCodes.EMBEDDING_FAILED, String(err)),
        })
      }
    }
    return
  }

  const embeddableSlice: Record<string, unknown>[] = []
  const embeddableOriginalIndexes: number[] = []
  for (let i = chunkStart; i < chunkEnd; i++) {
    if (chunkFailedIndexes.has(i)) continue
    embeddableSlice.push(documents[i] as Record<string, unknown>)
    embeddableOriginalIndexes.push(i)
  }
  if (embeddableSlice.length === 0) return

  try {
    const embedResult = await embedBatchDocumentFields(
      embeddableSlice,
      entry.config.embedding as EmbeddingFieldConfig,
      entry.embeddingAdapter,
      signal,
    )
    for (const [sliceIndex, error] of embedResult.failed) {
      const originalIdx = embeddableOriginalIndexes[sliceIndex]
      chunkFailedIndexes.add(originalIdx)
      failed.push({ docId: providedDocId(documents[originalIdx]) ?? '', error })
    }
  } catch (err) {
    const embeddingError = err instanceof NarsilError ? err : new NarsilError(ErrorCodes.EMBEDDING_FAILED, String(err))
    for (const originalIdx of embeddableOriginalIndexes) {
      chunkFailedIndexes.add(originalIdx)
      failed.push({ docId: providedDocId(documents[originalIdx]) ?? '', error: embeddingError })
    }
  }
}
