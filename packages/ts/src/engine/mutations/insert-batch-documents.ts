import type { BatchResult } from '../../types/results'
import type { InsertOptions } from '../../types/schema'
import { BATCH_CHUNK_SIZE } from '../constants'
import type { MutationContext } from './context'
import { asBatchInsertError } from './insert-admission'
import type { AdmittedInsert } from './insert-batch-admission'
import { applyInsertChunk } from './insert-batch-apply'

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
  const hasAfterHook = ctx.pluginRegistry.hasHooks('afterInsert')
  const succeeded: string[] = []
  const buffered = new Set<string>()
  const touchedVectorFields = new Set<string>()

  for (let chunkStart = 0; chunkStart < admitted.length; chunkStart += BATCH_CHUNK_SIZE) {
    if (ctx.abortController.signal.aborted) break

    const chunk = admitted.slice(chunkStart, chunkStart + BATCH_CHUNK_SIZE)
    const applications = await applyInsertChunk(ctx, indexName, chunk, options)

    for (let i = 0; i < chunk.length; i++) {
      const doc = chunk[i]
      const application = applications[i]
      if (application.status === 'skipped') continue
      if (application.status === 'failed') {
        failed.push({ docId: doc.docId, error: asBatchInsertError(application.error) })
        continue
      }
      if (application.status === 'buffered') {
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
    }

    if (chunkStart + BATCH_CHUNK_SIZE < admitted.length) {
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  return { succeeded, buffered, touchedVectorFields }
}
