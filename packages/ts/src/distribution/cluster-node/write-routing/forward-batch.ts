import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import type { AllocationTable, PartitionAssignment } from '../../coordinator/types'
import type {
  ForwardBatchOperation,
  ForwardBatchOperationResult,
  ForwardBatchPayload,
  WriteCondition,
} from '../../transport/types'
import { transportableDetails } from '../error-reply'
import { findWriteBlock } from '../memory/write-block'
import { estimateForwardedBytes } from '../memory/write-pressure'
import { abandonedWriteOf } from './abandoned-write'
import { requireAssignedPrimary, resolvePartitionId } from './assignment'
import type { BatchWrite, WriteFailure } from './batch-write'
import { decodeForwardedDocument } from './forwarded-document'
import { writableAssignment } from './initialising-partition'
import {
  applyPrimaryInsertBatch,
  applyPrimaryRemoveBatch,
  applyPrimaryUpdateBatch,
  resolveForwardedUpdateDocument,
} from './primary-writes'
import type { WriteRoutingDeps } from './types'
import { conditionOfFields } from './write-condition'

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

    const writable = await writableAssignment(deps, indexName, partitionId, assigned)
    await applyRunToPrimary(indexName, partitionId, run, writable, deps, results)
    for (const operation of run.operations) {
      if (results[operation.index] !== undefined) {
        continue
      }
      results[operation.index] = {
        documentId: operation.wire.documentId,
        success: true,
        errorCode: null,
        errorMessage: null,
      }
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
): Promise<void> {
  const positions = new Map<BatchWrite<unknown>, number>()
  function reportFailures(failed: readonly WriteFailure<unknown>[]): void {
    for (const { write, error } of failed) {
      const position = positions.get(write)
      if (position !== undefined) results[position] = failureResult(write.docId, error)
    }
  }

  if (run.operation === 'remove') {
    const removals: BatchWrite<null>[] = []
    for (const { index, wire } of run.operations) {
      const condition = conditionOrFailure(wire, results, index)
      if (condition === null) continue
      const write: BatchWrite<null> = { docId: wire.documentId, value: null, condition }
      removals.push(write)
      positions.set(write, index)
    }
    reportFailures((await applyPrimaryRemoveBatch(indexName, removals, partitionId, assignment, deps)).failed)
    return
  }

  if (run.operation === 'insert') {
    const inserts: BatchWrite<AnyDocument>[] = []
    for (const { index, wire } of run.operations) {
      if (conditionOrFailure(wire, results, index) === null) continue
      const decodedDocument = decodeOperationDocument(wire, results, index)
      if (decodedDocument === null) continue
      const write: BatchWrite<AnyDocument> = { docId: wire.documentId, value: decodedDocument }
      inserts.push(write)
      positions.set(write, index)
    }
    reportFailures((await applyPrimaryInsertBatch(indexName, inserts, partitionId, assignment, deps)).failed)
    return
  }

  const updates: BatchWrite<AnyDocument>[] = []
  for (const operation of run.operations) {
    const condition = conditionOrFailure(operation.wire, results, operation.index)
    if (condition === null) continue
    try {
      const replacement = await resolveForwardedUpdateDocument(
        indexName,
        operation.wire.documentId,
        operation.wire.document,
        operation.wire.updateFields,
        deps,
      )
      const write: BatchWrite<AnyDocument> = { docId: operation.wire.documentId, value: replacement, condition }
      updates.push(write)
      positions.set(write, operation.index)
    } catch (err) {
      const error = err instanceof NarsilError ? err : new NarsilError(ErrorCodes.CONFIG_INVALID, String(err))
      results[operation.index] = failureResult(operation.wire.documentId, error)
    }
  }
  reportFailures((await applyPrimaryUpdateBatch(indexName, updates, partitionId, assignment, deps)).failed)
}

function conditionOrFailure(
  wire: ForwardBatchOperation,
  results: ForwardBatchOperationResult[],
  index: number,
): WriteCondition | undefined | null {
  try {
    return conditionOfFields(wire, wire.operation, wire.documentId)
  } catch (err) {
    const error = err instanceof NarsilError ? err : new NarsilError(ErrorCodes.REPLICATION_ENTRY_INVALID, String(err))
    results[index] = failureResult(wire.documentId, error)
    return null
  }
}

function decodeOperationDocument(
  wire: ForwardBatchOperation,
  results: ForwardBatchOperationResult[],
  index: number,
): AnyDocument | null {
  if (wire.document === null) {
    results[index] = failureResult(
      wire.documentId,
      new NarsilError(ErrorCodes.REPLICATION_ENTRY_INVALID, 'A forwarded insert requires a document', {
        documentId: wire.documentId,
      }),
    )
    return null
  }
  try {
    return decodeForwardedDocument(wire.document, wire.documentId)
  } catch (err) {
    const error = err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, String(err))
    results[index] = failureResult(wire.documentId, error)
    return null
  }
}

function failureResult(documentId: string, error: NarsilError): ForwardBatchOperationResult {
  const result: ForwardBatchOperationResult = {
    documentId,
    success: false,
    errorCode: error.code,
    errorMessage: error.message,
    errorDetails: transportableDetails(error) ?? null,
  }
  const abandonedWrite = abandonedWriteOf(error)
  if (abandonedWrite !== undefined) result.abandonedWrite = abandonedWrite
  return result
}
