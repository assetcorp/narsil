import { generateId } from '../../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { BatchResult } from '../../../types/results'
import type { AnyDocument, InsertOptions } from '../../../types/schema'
import type { AllocationTable, PartitionAssignment } from '../../coordinator/types'
import { routableAllocation } from '../routable-allocation'
import { requireAssignedPrimary, resolvePartitionId } from './assignment'
import { type ForwardBatchItem, forwardBatchToRemote } from './forward-batch'
import { applyPrimaryInsertBatch, applyPrimaryRemoveBatch, applyPrimaryUpdateBatch } from './primary-writes'
import type { WriteRoutingDeps } from './types'

type AssignedPrimary = PartitionAssignment & { primary: string }

interface RoutedBatch<T> {
  localGroups: Map<number, { assignment: AssignedPrimary; items: T[] }>
  remoteGroups: Map<string, T[]>
  failed: BatchResult['failed']
}

function routeBatchItems<T>(
  table: AllocationTable,
  indexName: string,
  items: T[],
  docIdOf: (item: T) => string,
  nodeId: string,
): RoutedBatch<T> {
  const partitionCount = table.assignments.size
  const failed: BatchResult['failed'] = []
  const localGroups = new Map<number, { assignment: AssignedPrimary; items: T[] }>()
  const remoteGroups = new Map<string, T[]>()

  for (const item of items) {
    const docId = docIdOf(item)
    const partitionId = resolvePartitionId(docId, partitionCount)
    const assignment = table.assignments.get(partitionId)

    let assignedPrimary: AssignedPrimary
    try {
      assignedPrimary = requireAssignedPrimary(assignment, indexName, partitionId)
    } catch (err) {
      failed.push({
        docId,
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
        group = { assignment: assignedPrimary, items: [] }
        localGroups.set(partitionId, group)
      }
      group.items.push(item)
      continue
    }

    let remote = remoteGroups.get(assignedPrimary.primary)
    if (remote === undefined) {
      remote = []
      remoteGroups.set(assignedPrimary.primary, remote)
    }
    remote.push(item)
  }

  return { localGroups, remoteGroups, failed }
}

function collectGroupFailure(
  failed: BatchResult['failed'],
  docIds: string[],
  err: unknown,
  indexName: string,
  fallbackCode: (typeof ErrorCodes)[keyof typeof ErrorCodes],
): void {
  const narsilErr = err instanceof NarsilError ? err : new NarsilError(fallbackCode, String(err), { indexName })
  for (const docId of docIds) {
    failed.push({ docId, error: narsilErr })
  }
}

export async function routeInsertBatch(
  indexName: string,
  documents: AnyDocument[],
  deps: WriteRoutingDeps,
  options?: InsertOptions,
): Promise<BatchResult> {
  const table = await routableAllocation(deps.coordinator, indexName)
  if (table === null) {
    return deps.engine.insertBatch(indexName, documents, options)
  }

  const withIds = documents.map(doc => ({
    doc,
    docId: typeof doc.id === 'string' && doc.id.length > 0 ? doc.id : generateId(),
  }))
  const routed = routeBatchItems(table, indexName, withIds, item => item.docId, deps.nodeId)
  const succeeded: string[] = []
  const failed = routed.failed

  for (const [partitionId, group] of routed.localGroups) {
    try {
      const result = await applyPrimaryInsertBatch(indexName, group.items, partitionId, group.assignment, deps, options)
      succeeded.push(...result.succeeded)
      failed.push(...result.failed)
    } catch (err) {
      collectGroupFailure(
        failed,
        group.items.map(item => item.docId),
        err,
        indexName,
        ErrorCodes.DOC_VALIDATION_FAILED,
      )
    }
  }

  for (const [primaryNodeId, items] of routed.remoteGroups) {
    const result = await forwardBatchToRemote(
      indexName,
      items.map((item): ForwardBatchItem => ({ documentId: item.docId, operation: 'insert', document: item.doc })),
      primaryNodeId,
      deps,
    )
    succeeded.push(...result.succeeded)
    failed.push(...result.failed)
  }

  return { succeeded, failed }
}

export async function routeRemoveBatch(
  indexName: string,
  docIds: string[],
  deps: WriteRoutingDeps,
): Promise<BatchResult> {
  const table = await routableAllocation(deps.coordinator, indexName)
  if (table === null) {
    return deps.engine.removeBatch(indexName, docIds)
  }

  const routed = routeBatchItems(table, indexName, docIds, docId => docId, deps.nodeId)
  const succeeded: string[] = []
  const failed = routed.failed

  for (const [partitionId, group] of routed.localGroups) {
    try {
      const result = await applyPrimaryRemoveBatch(indexName, group.items, partitionId, group.assignment, deps)
      succeeded.push(...result.succeeded)
      failed.push(...result.failed)
    } catch (err) {
      collectGroupFailure(failed, group.items, err, indexName, ErrorCodes.QUERY_ROUTING_FAILED)
    }
  }

  for (const [primaryNodeId, items] of routed.remoteGroups) {
    const result = await forwardBatchToRemote(
      indexName,
      items.map((docId): ForwardBatchItem => ({ documentId: docId, operation: 'remove', document: null })),
      primaryNodeId,
      deps,
    )
    succeeded.push(...result.succeeded)
    failed.push(...result.failed)
  }

  return { succeeded, failed }
}

export async function routeUpdateBatch(
  indexName: string,
  updates: Array<{ docId: string; document: AnyDocument }>,
  deps: WriteRoutingDeps,
): Promise<BatchResult> {
  const table = await routableAllocation(deps.coordinator, indexName)
  if (table === null) {
    return deps.engine.updateBatch(indexName, updates)
  }

  const routed = routeBatchItems(table, indexName, updates, update => update.docId, deps.nodeId)
  const succeeded: string[] = []
  const failed = routed.failed

  for (const [partitionId, group] of routed.localGroups) {
    try {
      const result = await applyPrimaryUpdateBatch(indexName, group.items, partitionId, group.assignment, deps)
      succeeded.push(...result.succeeded)
      failed.push(...result.failed)
    } catch (err) {
      collectGroupFailure(
        failed,
        group.items.map(item => item.docId),
        err,
        indexName,
        ErrorCodes.DOC_VALIDATION_FAILED,
      )
    }
  }

  for (const [primaryNodeId, items] of routed.remoteGroups) {
    const result = await forwardBatchToRemote(
      indexName,
      items.map(
        (update): ForwardBatchItem => ({ documentId: update.docId, operation: 'update', document: update.document }),
      ),
      primaryNodeId,
      deps,
    )
    succeeded.push(...result.succeeded)
    failed.push(...result.failed)
  }

  return { succeeded, failed }
}
