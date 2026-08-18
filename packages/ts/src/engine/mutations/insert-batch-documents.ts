import type { BatchResult } from '../../types/results'
import type { InsertOptions } from '../../types/schema'
import { BATCH_CHUNK_SIZE } from '../validation'
import { insertDocumentVectors } from '../vector-coordinator'
import type { MutationContext } from './context'
import { rollbackInsertedDocument } from './durable-rollback'
import { admitInsert, asBatchInsertError } from './insert-admission'
import type { AdmittedInsert } from './insert-batch-admission'

export interface AppliedAdmission {
  succeeded: string[]
  buffered: Set<string>
  touchedVectorFields: Set<string>
}

export async function applyAdmittedDocuments(
  ctx: MutationContext,
  indexName: string,
  admitted: AdmittedInsert[],
  options: InsertOptions | undefined,
  failed: BatchResult['failed'],
): Promise<AppliedAdmission> {
  const manager = ctx.requireManager(indexName)
  const vecIndexes = manager.getVectorIndexes()
  const hasAfterHook = ctx.pluginRegistry.hasHooks('afterInsert')
  const succeeded: string[] = []
  const buffered = new Set<string>()
  const touchedVectorFields = new Set<string>()

  for (let i = 0; i < admitted.length; i++) {
    if (ctx.abortController.signal.aborted) break

    const doc = admitted[i]
    try {
      let inserted = false
      let docBuffered = false
      const apply = async (): Promise<void> => {
        admitInsert(ctx, indexName, manager, doc.docId)
        if (
          ctx.bufferIfRebalancing(indexName, {
            action: 'insert',
            docId: doc.docId,
            document: doc.document,
            indexName,
          })
        ) {
          docBuffered = true
          return
        }
        await ctx.executor.execute({
          type: 'insert',
          indexName,
          docId: doc.docId,
          document: doc.partitionDoc,
          requestId: doc.docId,
          skipClone: doc.extractedVectors.size > 0 ? true : options?.skipClone,
        })
        inserted = true
        try {
          insertDocumentVectors(doc.docId, doc.extractedVectors, vecIndexes, manager.partitionIdOf(doc.docId))
        } catch (vecErr) {
          try {
            await ctx.executor.execute({ type: 'remove', indexName, docId: doc.docId, requestId: doc.docId })
            inserted = false
          } catch (rollbackErr) {
            console.warn(
              `Rollback failed for doc "${doc.docId}" during batch insert atomicity:`,
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            )
          }
          throw vecErr
        }
      }

      if (ctx.durability) {
        try {
          await ctx.durability.recordInsertOrUpdate(indexName, doc.docId, doc.document, apply)
        } catch (durableErr) {
          await rollbackInsertedDocument(ctx, indexName, doc.docId, inserted, durableErr)
          throw durableErr
        }
      } else {
        await apply()
      }

      if (docBuffered) {
        buffered.add(doc.docId)
        succeeded.push(doc.docId)
        continue
      }

      for (const fieldPath of doc.extractedVectors.keys()) {
        touchedVectorFields.add(fieldPath)
      }

      if (hasAfterHook) {
        try {
          await ctx.pluginRegistry.runHook('afterInsert', { indexName, docId: doc.docId, document: doc.document })
        } catch (err) {
          console.warn('afterInsert plugin hook error:', err instanceof Error ? err.message : String(err))
        }
      }

      succeeded.push(doc.docId)
    } catch (err) {
      failed.push({ docId: doc.docId, error: asBatchInsertError(err) })
    }

    if ((i + 1) % BATCH_CHUNK_SIZE === 0 && i + 1 < admitted.length) {
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  return { succeeded, buffered, touchedVectorFields }
}
