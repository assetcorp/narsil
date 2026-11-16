import { capsEachPartition, ErrorCodes, NarsilError } from '#platform/optional-writes-host'
import type { PartitionManager } from '../../partitioning/manager'
import { batchFailureOf } from './batch-shutdown'
import type { MutationContext } from './context'

export interface PendingAdmissions {
  total: number
  byPartition: Map<number, number>
}

export function createPendingAdmissions(): PendingAdmissions {
  return { total: 0, byPartition: new Map() }
}

export function recordPendingAdmission(
  ctx: MutationContext,
  pending: PendingAdmissions,
  manager: PartitionManager,
  docId: string,
): void {
  pending.total += 1
  if (!capsEachPartition(ctx, manager)) return
  const partitionId = manager.routePartition(docId)
  pending.byPartition.set(partitionId, (pending.byPartition.get(partitionId) ?? 0) + 1)
}

function insertErrorOf(err: unknown): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, String(err))
}

export function asBatchInsertError(ctx: MutationContext, err: unknown): NarsilError {
  return batchFailureOf(ctx, err, insertErrorOf)
}
