import { type ProjectedGroup, WRITE_WOULD_FILL_MEMORY_REASON } from '../../../engine/memory/write-projection'
import { yieldToEventLoop } from '../../../engine/orchestration/turn'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import { WRITE_APPLY_YIELD_INTERVAL_MS } from '../constants'
import type { BatchWrite, WriteFailure } from './batch-write'
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

export interface ProjectedBatch {
  writes: readonly BatchWrite<AnyDocument>[]
  failed: WriteFailure<AnyDocument>[]
  apply: (write: BatchWrite<AnyDocument>) => Promise<void>
  afterGroup?: () => Promise<void>
}

function createTurnBudget(): () => Promise<void> {
  let turnStartedAt = performance.now()
  return async () => {
    if (performance.now() - turnStartedAt < WRITE_APPLY_YIELD_INTERVAL_MS) return
    await yieldToEventLoop()
    turnStartedAt = performance.now()
  }
}

export async function applyInProjectedGroups(
  deps: WriteRoutingDeps,
  indexName: string,
  batch: ProjectedBatch,
): Promise<void> {
  const projection = deps.writeProjection
  const bound = projection?.boundOf(indexName) ?? null
  const yieldIfDue = createTurnBudget()
  if (projection === undefined || bound === null) {
    for (const write of batch.writes) {
      await batch.apply(write)
      await yieldIfDue()
    }
    await batch.afterGroup?.()
    return
  }

  const bounds: number[] = []
  const bounded: BatchWrite<AnyDocument>[] = []
  for (const write of batch.writes) {
    try {
      bounds.push(bound(write.value))
      bounded.push(write)
    } catch (err) {
      batch.failed.push({ write, error: asDocumentError(err, write.docId) })
    }
  }

  let start = 0
  while (start < bounded.length) {
    let group: ProjectedGroup
    try {
      group = projection.takeGroup(indexName, bounds, start)
    } catch (err) {
      const refused = bounded[start]
      batch.failed.push({ write: refused, error: asDocumentError(err, refused.docId) })
      for (let index = start + 1; index < bounded.length; index++) {
        const write = bounded[index]
        batch.failed.push({ write, error: refusedAfter(deps.nodeId, indexName, write.docId, refused.docId) })
      }
      return
    }
    try {
      for (let index = start; index < start + group.count; index++) {
        await batch.apply(bounded[index])
        await yieldIfDue()
      }
      await batch.afterGroup?.()
    } finally {
      group.release()
    }
    start += group.count
  }
}
