import { BATCH_CHUNK_SIZE } from '#platform/optional-writes-host'
import type { BatchResult } from '../../types/results'
import type { InsertOptions } from '../../types/schema'
import type { IndexHold } from '../index-hold'
import { asBatchInsertError } from './batch-admissions'
import type { MutationContext } from './context'
import type { AdmittedInsert } from './insert-batch-admission'
import { applyInsertChunk } from './insert-batch-apply'

export interface AppliedAdmission {
  succeeded: string[]
  buffered: Set<string>
  inserted: AdmittedInsert[]
  touchedVectorFields: Set<string>
}

export async function runAfterInsertHooks(
  ctx: MutationContext,
  indexName: string,
  inserted: AdmittedInsert[],
  hold: IndexHold | undefined,
): Promise<void> {
  if (inserted.length === 0 || !ctx.pluginRegistry.hasHooks('afterInsert')) return
  const runHooks = async (): Promise<void> => {
    for (const doc of inserted) {
      try {
        await ctx.pluginRegistry.runHook('afterInsert', { indexName, docId: doc.docId, document: doc.document })
      } catch (err) {
        console.warn('afterInsert plugin hook error:', err instanceof Error ? err.message : String(err))
      }
    }
  }
  if (hold === undefined) await runHooks()
  else hold.afterRelease(runHooks)
}

export async function applyAdmittedDocuments(
  ctx: MutationContext,
  indexName: string,
  admitted: AdmittedInsert[],
  options: InsertOptions | undefined,
  failed: BatchResult['failed'],
): Promise<AppliedAdmission> {
  const succeeded: string[] = []
  const buffered = new Set<string>()
  const inserted: AdmittedInsert[] = []
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
      inserted.push(doc)
      succeeded.push(doc.docId)
    }

    const applied = chunkStart + BATCH_CHUNK_SIZE
    if (applied < admitted.length) {
      ctx.checkHeapPressure(indexName)
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  return { succeeded, buffered, inserted, touchedVectorFields }
}
