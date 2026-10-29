import { yieldToEventLoop } from '../../../engine/orchestration/turn'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { BatchResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import { WRITE_APPLY_YIELD_INTERVAL_MS } from '../constants'
import { type ProjectedGroup, WRITE_WOULD_FILL_MEMORY_REASON } from '../memory/write-projection'
import type { WriteRoutingDeps } from './types'

const UNPROJECTED: ProjectedGroup = { count: 1, release: () => {} }

function asDocumentError(err: unknown, docId: string): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, String(err), { docId })
}

function refusedAfter(nodeId: string, indexName: string, docId: string, refusedDocId: string): NarsilError {
  return new NarsilError(
    ErrorCodes.CLUSTER_WRITE_BLOCKED,
    `Node '${nodeId}' refuses document '${docId}' for index '${indexName}' because document '${refusedDocId}' before it in the batch would not fit in the node's memory. Retry the refused documents once the writes in progress finish.`,
    { reason: WRITE_WOULD_FILL_MEMORY_REASON, indexName, nodeId, docId, refusedDocId },
  )
}

export function projectOne(deps: WriteRoutingDeps, indexName: string, document: AnyDocument): ProjectedGroup {
  const projection = deps.writeProjection
  const bound = projection?.boundOf(indexName) ?? null
  if (projection === undefined || bound === null) return UNPROJECTED
  return projection.takeOne(indexName, bound(document))
}

export interface ProjectedBatch<T> {
  items: readonly T[]
  documentOf: (item: T) => AnyDocument
  docIdOf: (item: T) => string
  failed: BatchResult['failed']
  apply: (item: T) => Promise<void>
}

function createTurnBudget(): () => Promise<void> {
  let turnStartedAt = performance.now()
  return async () => {
    if (performance.now() - turnStartedAt < WRITE_APPLY_YIELD_INTERVAL_MS) return
    await yieldToEventLoop()
    turnStartedAt = performance.now()
  }
}

export async function applyInProjectedGroups<T>(
  deps: WriteRoutingDeps,
  indexName: string,
  batch: ProjectedBatch<T>,
): Promise<void> {
  const projection = deps.writeProjection
  const bound = projection?.boundOf(indexName) ?? null
  const yieldIfDue = createTurnBudget()
  if (projection === undefined || bound === null) {
    for (const item of batch.items) {
      await batch.apply(item)
      await yieldIfDue()
    }
    return
  }

  const bounds: number[] = []
  const bounded: T[] = []
  for (const item of batch.items) {
    try {
      bounds.push(bound(batch.documentOf(item)))
      bounded.push(item)
    } catch (err) {
      batch.failed.push({ docId: batch.docIdOf(item), error: asDocumentError(err, batch.docIdOf(item)) })
    }
  }

  let start = 0
  while (start < bounded.length) {
    let group: ProjectedGroup
    try {
      group = projection.takeGroup(indexName, bounds, start)
    } catch (err) {
      const refusedDocId = batch.docIdOf(bounded[start])
      batch.failed.push({ docId: refusedDocId, error: asDocumentError(err, refusedDocId) })
      for (let index = start + 1; index < bounded.length; index++) {
        const docId = batch.docIdOf(bounded[index])
        batch.failed.push({ docId, error: refusedAfter(deps.nodeId, indexName, docId, refusedDocId) })
      }
      return
    }
    try {
      for (let index = start; index < start + group.count; index++) {
        await batch.apply(bounded[index])
        await yieldIfDue()
      }
    } finally {
      group.release()
    }
    start += group.count
  }
}
