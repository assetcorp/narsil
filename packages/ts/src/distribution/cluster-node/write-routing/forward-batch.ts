import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { BatchResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { AllocationTable, PartitionAssignment } from '../../coordinator/types'
import type { ForwardBatchOperation, ForwardBatchOperationResult, ForwardBatchPayload } from '../../transport/types'
import { transportableDetails } from '../error-reply'
import { findWriteBlock } from '../memory/write-block'
import { estimateForwardedBytes } from '../memory/write-pressure'
import { requireAssignedPrimary, resolvePartitionId } from './assignment'
import {
  applyPrimaryInsertBatch,
  applyPrimaryRemoveBatch,
  applyPrimaryUpdateBatch,
  resolveForwardedUpdateDocument,
} from './primary-writes'
import type { WriteRoutingDeps } from './types'

interface OperationRun {
  partitionId: number
  operation: 'insert' | 'remove' | 'update'
  operations: Array<{ index: number; wire: ForwardBatchOperation }>
}

function groupIntoRuns(payload: ForwardBatchPayload, partitionCount: number): Map<number, OperationRun[]> {
  const runsByPartition = new Map<number, OperationRun[]>()
  for (let index = 0; index < payload.operations.length; index++) {
    const wire = payload.operations[index]
    const partitionId = resolvePartitionId(wire.documentId, partitionCount)
    let runs = runsByPartition.get(partitionId)
    if (runs === undefined) {
      runs = []
      runsByPartition.set(partitionId, runs)
    }
    const lastRun = runs[runs.length - 1]
    if (lastRun !== undefined && lastRun.operation === wire.operation) {
      lastRun.operations.push({ index, wire })
    } else {
      runs.push({ partitionId, operation: wire.operation, operations: [{ index, wire }] })
    }
  }
  return runsByPartition
}

function admitForwardedWrites(
  payload: ForwardBatchPayload,
  deps: WriteRoutingDeps,
): { release: () => void; refusal: NarsilError | null } {
  let bytes = 0
  for (const operation of payload.operations) {
    if (operation.operation !== 'remove') {
      bytes += estimateForwardedBytes(operation)
    }
  }
  if (deps.writePressure === undefined || bytes === 0) {
    return { release: () => {}, refusal: null }
  }
  try {
    return { release: deps.writePressure.admit(payload.indexName, bytes), refusal: null }
  } catch (error) {
    if (!(error instanceof NarsilError)) {
      throw error
    }
    return { release: () => {}, refusal: error }
  }
}

export async function applyForwardedBatch(
  payload: ForwardBatchPayload,
  deps: WriteRoutingDeps,
): Promise<ForwardBatchOperationResult[]> {
  const admission = admitForwardedWrites(payload, deps)
  try {
    return await applyAdmittedForwardedBatch(payload, deps, admission.refusal)
  } finally {
    admission.release()
  }
}

function leadsEveryPartition(table: AllocationTable | null, payload: ForwardBatchPayload, nodeId: string): boolean {
  if (table === null || table.assignments.size === 0) return false
  return payload.operations.every(
    operation =>
      table.assignments.get(resolvePartitionId(operation.documentId, table.assignments.size))?.primary === nodeId,
  )
}

async function applyAdmittedForwardedBatch(
  payload: ForwardBatchPayload,
  deps: WriteRoutingDeps,
  refusal: NarsilError | null,
): Promise<ForwardBatchOperationResult[]> {
  const results: ForwardBatchOperationResult[] = new Array(payload.operations.length)
  let table = await deps.coordinator.getAllocation(payload.indexName)
  if (deps.refreshAllocation !== undefined && !leadsEveryPartition(table, payload, deps.nodeId)) {
    table = await deps.refreshAllocation(payload.indexName)
  }

  if (table === null || table.assignments.size === 0) {
    const error = new NarsilError(
      ErrorCodes.QUERY_ROUTING_FAILED,
      `No allocation table is available for forwarded batch to index '${payload.indexName}'`,
      { indexName: payload.indexName },
    )
    for (let index = 0; index < payload.operations.length; index++) {
      results[index] = failureResult(payload.operations[index].documentId, error)
    }
    return results
  }

  const runsByPartition = groupIntoRuns(payload, table.assignments.size)
  const writesIndex = payload.operations.some(operation => operation.operation !== 'remove')
  const block = writesIndex ? (refusal ?? findWriteBlock(table, deps.memoryView)) : null

  await Promise.all(
    Array.from(runsByPartition.entries()).map(async ([partitionId, runs]) => {
      for (const run of runs) {
        if (block !== null && run.operation !== 'remove') {
          for (const { index, wire } of run.operations) {
            results[index] = failureResult(wire.documentId, block)
          }
          continue
        }
        await applyRun(payload.indexName, partitionId, run, table.assignments.get(partitionId), deps, results)
      }
    }),
  )

  return results
}

async function applyRun(
  indexName: string,
  partitionId: number,
  run: OperationRun,
  assignment: PartitionAssignment | undefined,
  deps: WriteRoutingDeps,
  results: ForwardBatchOperationResult[],
): Promise<void> {
  try {
    const assigned = requireAssignedPrimary(assignment, indexName, partitionId)
    if (assigned.primary !== deps.nodeId) {
      throw new NarsilError(
        ErrorCodes.PARTITION_NOT_PRIMARY,
        `Node '${deps.nodeId}' is not primary for partition ${partitionId} of index '${indexName}'`,
        { indexName, partitionId, nodeId: deps.nodeId },
      )
    }

    const batchResult = await applyRunToPrimary(indexName, partitionId, run, assigned, deps, results)
    const failedByDocId = new Map(batchResult.failed.map(failure => [failure.docId, failure.error]))
    for (const operation of run.operations) {
      if (results[operation.index] !== undefined) {
        continue
      }
      const failure = failedByDocId.get(operation.wire.documentId)
      results[operation.index] =
        failure === undefined
          ? { documentId: operation.wire.documentId, success: true, errorCode: null, errorMessage: null }
          : failureResult(operation.wire.documentId, failure)
    }
  } catch (err) {
    const error = err instanceof NarsilError ? err : new NarsilError(ErrorCodes.QUERY_ROUTING_FAILED, String(err))
    for (const operation of run.operations) {
      if (results[operation.index] === undefined) {
        results[operation.index] = failureResult(operation.wire.documentId, error)
      }
    }
  }
}

async function applyRunToPrimary(
  indexName: string,
  partitionId: number,
  run: OperationRun,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
  results: ForwardBatchOperationResult[],
): Promise<BatchResult> {
  if (run.operation === 'remove') {
    return applyPrimaryRemoveBatch(
      indexName,
      run.operations.map(operation => operation.wire.documentId),
      partitionId,
      assignment,
      deps,
    )
  }

  if (run.operation === 'insert') {
    const items: Array<{ doc: AnyDocument; docId: string }> = []
    for (const operation of run.operations) {
      const decodedDocument = decodeOperationDocument(operation.wire, results, operation.index)
      if (decodedDocument !== null) {
        items.push({ doc: decodedDocument, docId: operation.wire.documentId })
      }
    }
    return applyPrimaryInsertBatch(indexName, items, partitionId, assignment, deps)
  }

  const updates: Array<{ docId: string; document: AnyDocument }> = []
  for (const operation of run.operations) {
    try {
      const replacement = await resolveForwardedUpdateDocument(
        indexName,
        operation.wire.documentId,
        operation.wire.document,
        operation.wire.updateFields,
        deps,
      )
      updates.push({ docId: operation.wire.documentId, document: replacement })
    } catch (err) {
      const error = err instanceof NarsilError ? err : new NarsilError(ErrorCodes.CONFIG_INVALID, String(err))
      results[operation.index] = failureResult(operation.wire.documentId, error)
    }
  }
  return applyPrimaryUpdateBatch(indexName, updates, partitionId, assignment, deps)
}

function decodeOperationDocument(
  wire: ForwardBatchOperation,
  results: ForwardBatchOperationResult[],
  index: number,
): AnyDocument | null {
  if (wire.document === null) {
    results[index] = failureResult(
      wire.documentId,
      new NarsilError(ErrorCodes.CONFIG_INVALID, 'A forwarded insert requires a document', {
        documentId: wire.documentId,
      }),
    )
    return null
  }
  try {
    return decode(wire.document) as AnyDocument
  } catch (err) {
    results[index] = failureResult(
      wire.documentId,
      new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, `Forwarded document could not be decoded: ${String(err)}`, {
        documentId: wire.documentId,
      }),
    )
    return null
  }
}

function failureResult(documentId: string, error: NarsilError): ForwardBatchOperationResult {
  return {
    documentId,
    success: false,
    errorCode: error.code,
    errorMessage: error.message,
    errorDetails: transportableDetails(error) ?? null,
  }
}
