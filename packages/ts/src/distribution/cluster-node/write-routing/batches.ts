import { generateId } from '../../../core/id-generator'
import { ErrorCodes, NarsilError, type NarsilErrorCode } from '../../../errors'
import type { BatchResult } from '../../../types/results'
import type { AnyDocument, InsertOptions } from '../../../types/schema'
import type { AllocationTable, PartitionAssignment } from '../../coordinator/types'
import { requireWritableIndex } from '../memory/write-block'
import { estimateDocumentsBytes, withAdmittedWrite } from '../memory/write-pressure'
import { routableAllocation } from '../routable-allocation'
import { requireAssignedPrimary, resolvePartitionId } from './assignment'
import type { BatchOutcome, BatchWrite, WriteFailure } from './batch-write'
import { type ForwardedOperation, forwardBatchToRemote } from './forward-to-primary'
import { unsentAfterWindow, windowClosed } from './forward-window'
import { writableAssignment } from './initialising-partition'
import { writeLocalOnly } from './numbered-write'
import { retryEachPartition, settleEqualInserts, settleNothing } from './primary-change'
import { applyPrimaryInsertBatch, applyPrimaryRemoveBatch, applyPrimaryUpdateBatch } from './primary-writes'
import type { WriteRoutingDeps } from './types'

type AssignedPrimary = PartitionAssignment & { primary: string }

type ApplyAsPrimary<V> = (
  writes: BatchWrite<V>[],
  partitionId: number,
  assignment: PartitionAssignment,
) => Promise<BatchOutcome<V>>

interface RoutedBatch<V> {
  localGroups: Map<number, { assignment: AssignedPrimary; writes: BatchWrite<V>[] }>
  remoteGroups: Map<string, BatchWrite<V>[]>
  failed: WriteFailure<V>[]
}

function routeBatchWrites<V>(
  table: AllocationTable,
  indexName: string,
  writes: BatchWrite<V>[],
  nodeId: string,
): RoutedBatch<V> {
  const partitionCount = table.assignments.size
  const failed: WriteFailure<V>[] = []
  const localGroups = new Map<number, { assignment: AssignedPrimary; writes: BatchWrite<V>[] }>()
  const remoteGroups = new Map<string, BatchWrite<V>[]>()

  for (const write of writes) {
    const partitionId = resolvePartitionId(write.docId, partitionCount)
    const assignment = table.assignments.get(partitionId)

    let assignedPrimary: AssignedPrimary
    try {
      assignedPrimary = requireAssignedPrimary(assignment, indexName, partitionId)
    } catch (err) {
      failed.push({
        write,
        error:
          err instanceof NarsilError
            ? err
            : new NarsilError(ErrorCodes.QUERY_ROUTING_FAILED, String(err), { indexName, partitionId }),
      })
      continue
    }

    if (assignedPrimary.primary === nodeId) {
      let group = localGroups.get(partitionId)
      if (group === undefined) {
        group = { assignment: assignedPrimary, writes: [] }
        localGroups.set(partitionId, group)
      }
      group.writes.push(write)
      continue
    }

    let remote = remoteGroups.get(assignedPrimary.primary)
    if (remote === undefined) {
      remote = []
      remoteGroups.set(assignedPrimary.primary, remote)
    }
    remote.push(write)
  }

  return { localGroups, remoteGroups, failed }
}

async function routeWrites<V extends AnyDocument | null>(
  deps: WriteRoutingDeps,
  indexName: string,
  operation: ForwardedOperation,
  writes: BatchWrite<V>[],
  applyAsPrimary: ApplyAsPrimary<V>,
  fallbackCode: NarsilErrorCode,
  deadline: number,
): Promise<BatchOutcome<V>> {
  const table = await requireRoutableTable(deps, indexName)
  const { localGroups, remoteGroups, failed } = routeBatchWrites(table, indexName, writes, deps.nodeId)
  const succeeded: BatchWrite<V>[] = []

  for (const [partitionId, group] of localGroups) {
    if (windowClosed(deadline)) {
      for (const unsent of unsentAfterWindow(indexName, group.writes)) failed.push(unsent)
      continue
    }
    try {
      const assignment = await writableAssignment(deps, indexName, partitionId, group.assignment)
      const result = await applyAsPrimary(group.writes, partitionId, assignment)
      for (const write of result.succeeded) succeeded.push(write)
      for (const failure of result.failed) failed.push(failure)
    } catch (err) {
      const error = err instanceof NarsilError ? err : new NarsilError(fallbackCode, String(err), { indexName })
      for (const write of group.writes) failed.push({ write, error })
    }
  }

  for (const [primaryNodeId, forwarded] of remoteGroups) {
    const target = { primaryNodeId, indexUuid: table.indexUuid, deadline }
    const result = await forwardBatchToRemote(indexName, operation, forwarded, target, deps)
    for (const write of result.succeeded) succeeded.push(write)
    for (const failure of result.failed) failed.push(failure)
  }

  return { succeeded, failed }
}

async function requireRoutableTable(deps: WriteRoutingDeps, indexName: string): Promise<AllocationTable> {
  const table = await routableAllocation(deps.coordinator, indexName)
  if (table === null) {
    throw new NarsilError(
      ErrorCodes.QUERY_ROUTING_FAILED,
      `Index '${indexName}' lost its cluster metadata while a batch waited for a new primary`,
      { indexName },
    )
  }
  return table
}

export function routeInsertBatch(
  indexName: string,
  documents: AnyDocument[],
  deps: WriteRoutingDeps,
  options?: InsertOptions,
): Promise<BatchResult> {
  return withAdmittedWrite(
    deps.writePressure,
    indexName,
    () => estimateDocumentsBytes(documents),
    () => routeAdmittedInsertBatch(indexName, documents, deps, options),
  )
}

async function routeAdmittedInsertBatch(
  indexName: string,
  documents: AnyDocument[],
  deps: WriteRoutingDeps,
  options?: InsertOptions,
): Promise<BatchResult> {
  const table = await routableAllocation(deps.coordinator, indexName)
  if (table === null) {
    return writeLocalOnly(deps, indexName, () => deps.engine.insertBatch(indexName, documents, options))
  }
  requireWritableIndex(table, deps.memoryView)

  const writes: BatchWrite<AnyDocument>[] = documents.map(document => ({
    docId: typeof document.id === 'string' && document.id.length > 0 ? document.id : generateId(),
    value: document,
  }))
  const applyAsPrimary: ApplyAsPrimary<AnyDocument> = (group, partitionId, assignment) =>
    applyPrimaryInsertBatch(indexName, group, partitionId, assignment, deps, options)
  return retryEachPartition(
    deps,
    indexName,
    table,
    writes,
    (pending, deadline) =>
      routeWrites(deps, indexName, 'insert', pending, applyAsPrimary, ErrorCodes.DOC_VALIDATION_FAILED, deadline),
    settleEqualInserts(deps, indexName),
    true,
  )
}

export async function routeRemoveBatch(
  indexName: string,
  docIds: string[],
  deps: WriteRoutingDeps,
): Promise<BatchResult> {
  const table = await routableAllocation(deps.coordinator, indexName)
  if (table === null) {
    return writeLocalOnly(deps, indexName, () => deps.engine.removeBatch(indexName, docIds))
  }

  const writes: BatchWrite<null>[] = docIds.map(docId => ({ docId, value: null }))
  const applyAsPrimary: ApplyAsPrimary<null> = (group, partitionId, assignment) =>
    applyPrimaryRemoveBatch(indexName, group, partitionId, assignment, deps)
  return retryEachPartition(
    deps,
    indexName,
    table,
    writes,
    (pending, deadline) =>
      routeWrites(deps, indexName, 'remove', pending, applyAsPrimary, ErrorCodes.QUERY_ROUTING_FAILED, deadline),
    settleNothing,
  )
}

export function routeUpdateBatch(
  indexName: string,
  updates: Array<{ docId: string; document: AnyDocument }>,
  deps: WriteRoutingDeps,
): Promise<BatchResult> {
  return withAdmittedWrite(
    deps.writePressure,
    indexName,
    () => estimateDocumentsBytes(updates.map(update => update.document)),
    () => routeAdmittedUpdateBatch(indexName, updates, deps),
  )
}

async function routeAdmittedUpdateBatch(
  indexName: string,
  updates: Array<{ docId: string; document: AnyDocument }>,
  deps: WriteRoutingDeps,
): Promise<BatchResult> {
  const table = await routableAllocation(deps.coordinator, indexName)
  if (table === null) {
    return writeLocalOnly(deps, indexName, () => deps.engine.updateBatch(indexName, updates))
  }
  requireWritableIndex(table, deps.memoryView)

  const writes: BatchWrite<AnyDocument>[] = updates.map(update => ({ docId: update.docId, value: update.document }))
  const applyAsPrimary: ApplyAsPrimary<AnyDocument> = (group, partitionId, assignment) =>
    applyPrimaryUpdateBatch(indexName, group, partitionId, assignment, deps)
  return retryEachPartition(
    deps,
    indexName,
    table,
    writes,
    (pending, deadline) =>
      routeWrites(deps, indexName, 'update', pending, applyAsPrimary, ErrorCodes.DOC_VALIDATION_FAILED, deadline),
    settleNothing,
  )
}
