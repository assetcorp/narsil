import type { InsertOptions } from '../../types/schema'
import { insertDocumentVectors } from '../vector-coordinator'
import type { DurableInsertOutcome, MutationContext } from './context'
import { rollbackInsertedDocument } from './durable-rollback'
import { admitInsert } from './insert-admission'
import type { AdmittedInsert } from './insert-batch-admission'

export type InsertApplication =
  | { status: 'inserted' }
  | { status: 'buffered' }
  | { status: 'skipped' }
  | { status: 'failed'; error: unknown }

interface InsertProgress {
  inserted: boolean
  buffered: boolean
  skipped: boolean
}

function applyOf(
  ctx: MutationContext,
  indexName: string,
  doc: AdmittedInsert,
  options: InsertOptions | undefined,
  progress: InsertProgress,
): () => Promise<void> {
  const manager = ctx.requireManager(indexName)
  return async (): Promise<void> => {
    if (ctx.abortController.signal.aborted) {
      progress.skipped = true
      throw ctx.abortController.signal.reason
    }
    admitInsert(ctx, indexName, manager, doc.docId)
    if (ctx.bufferIfRebalancing(indexName, { action: 'insert', docId: doc.docId, document: doc.document, indexName })) {
      progress.buffered = true
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
    progress.inserted = true
    try {
      insertDocumentVectors(
        doc.docId,
        doc.extractedVectors,
        manager.getVectorIndexes(),
        manager.partitionIdOf(doc.docId),
      )
    } catch (vecErr) {
      try {
        await ctx.executor.execute({ type: 'remove', indexName, docId: doc.docId, requestId: doc.docId })
        progress.inserted = false
      } catch (rollbackErr) {
        console.warn(
          `Rollback failed for doc "${doc.docId}" during batch insert atomicity:`,
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        )
      }
      throw vecErr
    }
  }
}

interface InsertFailure {
  error: unknown
}

async function failureOfApply(apply: () => Promise<void>): Promise<InsertFailure | null> {
  try {
    await apply()
    return null
  } catch (error) {
    return { error }
  }
}

function failureOfOutcome(outcome: DurableInsertOutcome): InsertFailure | null {
  return outcome.ok ? null : { error: outcome.error }
}

export async function applyInsertChunk(
  ctx: MutationContext,
  indexName: string,
  docs: readonly AdmittedInsert[],
  options: InsertOptions | undefined,
): Promise<InsertApplication[]> {
  const progress: InsertProgress[] = docs.map(() => ({ inserted: false, buffered: false, skipped: false }))
  const applies = docs.map((doc, i) => applyOf(ctx, indexName, doc, options, progress[i]))

  let failures: (InsertFailure | null)[]
  if (ctx.durability) {
    const outcomes = await ctx.durability.recordInsertOrUpdateBatch(
      indexName,
      docs.map((doc, i) => ({ docId: doc.docId, document: doc.document, apply: applies[i] })),
    )
    failures = outcomes.map(failureOfOutcome)
  } else {
    failures = []
    for (const apply of applies) {
      failures.push(await failureOfApply(apply))
    }
  }

  const applications: InsertApplication[] = []
  for (let i = 0; i < docs.length; i++) {
    if (progress[i].skipped) {
      applications.push({ status: 'skipped' })
      continue
    }
    const failure = failures[i]
    if (failure !== null) {
      let error = failure.error
      if (ctx.durability) {
        try {
          await rollbackInsertedDocument(ctx, indexName, docs[i].docId, progress[i].inserted, error)
        } catch (rollbackError) {
          error = rollbackError
        }
      }
      applications.push({ status: 'failed', error })
      continue
    }
    applications.push({ status: progress[i].buffered ? 'buffered' : 'inserted' })
  }
  return applications
}
