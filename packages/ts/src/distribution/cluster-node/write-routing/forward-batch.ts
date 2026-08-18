import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { BatchResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import { chunkByBudget, WIRE_BATCH_BUDGET } from '../../chunking'
import type { PartitionAssignment } from '../../coordinator/types'
import { createForwardBatchMessage, validateForwardBatchResultPayload } from '../../replication/codec'
import type { ForwardBatchOperation, ForwardBatchOperationResult, ForwardBatchPayload } from '../../transport/types'
import { requireAssignedPrimary, resolvePartitionId } from './assignment'
import {
  assertForwardResponse,
  forwardInsertToRemote,
  forwardRemoveToRemote,
  forwardUpdateToRemote,
  sendToNode,
} from './forwarding'
import {
  applyPrimaryInsertBatch,
  applyPrimaryRemoveBatch,
  applyPrimaryUpdateBatch,
  resolveForwardedUpdateDocument,
} from './primary-writes'
import type { WriteRoutingDeps } from './types'

export interface ForwardBatchItem {
  documentId: string
  operation: 'insert' | 'remove' | 'update'
  document: AnyDocument | null
}

function toWireOperation(item: ForwardBatchItem): ForwardBatchOperation {
  return {
    documentId: item.documentId,
    operation: item.operation,
    document: item.document === null ? null : encode(item.document),
    updateFields: null,
  }
}

function chunkWireOperations(operations: ForwardBatchOperation[]): ForwardBatchOperation[][] {
  return chunkByBudget(operations, {
    ...WIRE_BATCH_BUDGET,
    payloadBytesOf: operation => operation.document?.byteLength ?? 0,
  })
}

async function forwardSingleItem(
  indexName: string,
  item: ForwardBatchItem,
  primaryNodeId: string,
  deps: WriteRoutingDeps,
): Promise<string> {
  if (item.operation === 'insert') {
    if (item.document === null) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A forwarded insert requires a document', {
        documentId: item.documentId,
      })
    }
    return forwardInsertToRemote(indexName, item.document, item.documentId, primaryNodeId, deps)
  }
  if (item.operation === 'update') {
    if (item.document === null) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A forwarded update requires a document', {
        documentId: item.documentId,
      })
    }
    await forwardUpdateToRemote(indexName, item.document, item.documentId, primaryNodeId, deps)
    return item.documentId
  }
  await forwardRemoveToRemote(indexName, item.documentId, primaryNodeId, deps)
  return item.documentId
}

export async function forwardBatchToRemote(
  indexName: string,
  items: ForwardBatchItem[],
  primaryNodeId: string,
  deps: WriteRoutingDeps,
): Promise<BatchResult> {
  const succeeded: string[] = []
  const failed: BatchResult['failed'] = []

  if (items.length === 0) {
    return { succeeded, failed }
  }

  if (items.length === 1) {
    try {
      succeeded.push(await forwardSingleItem(indexName, items[0], primaryNodeId, deps))
    } catch (err) {
      failed.push({ docId: items[0].documentId, error: toForwardError(err, items[0].documentId) })
    }
    return { succeeded, failed }
  }

  const chunks = chunkWireOperations(items.map(toWireOperation))
  for (const chunk of chunks) {
    try {
      const payload: ForwardBatchPayload = { indexName, operations: chunk }
      const message = createForwardBatchMessage(payload, deps.nodeId)
      const response = await sendToNode(primaryNodeId, message, deps)
      const decoded = assertForwardResponse(response, indexName, primaryNodeId)
      const result = validateForwardBatchResultPayload(decoded)
      if (result.results.length !== chunk.length) {
        throw new NarsilError(
          ErrorCodes.QUERY_ROUTING_FAILED,
          `Remote primary answered ${result.results.length} results for ${chunk.length} forwarded operations`,
          { indexName, primaryNodeId },
        )
      }
      for (let index = 0; index < chunk.length; index++) {
        const operationResult = result.results[index]
        if (operationResult.documentId !== chunk[index].documentId) {
          failed.push({
            docId: chunk[index].documentId,
            error: new NarsilError(
              ErrorCodes.QUERY_ROUTING_FAILED,
              `Remote primary answered out of order for forwarded operation '${chunk[index].documentId}'`,
              { indexName, primaryNodeId },
            ),
          })
          continue
        }
        if (operationResult.success) {
          succeeded.push(operationResult.documentId)
          continue
        }
        failed.push({
          docId: operationResult.documentId,
          error: new NarsilError(
            operationResult.errorCode ?? ErrorCodes.QUERY_ROUTING_FAILED,
            operationResult.errorMessage ??
              `Remote primary rejected forwarded operation '${operationResult.documentId}'`,
            { indexName, primaryNodeId },
          ),
        })
      }
    } catch (err) {
      for (const operation of chunk) {
        failed.push({ docId: operation.documentId, error: toForwardError(err, operation.documentId) })
      }
    }
  }

  return { succeeded, failed }
}

function toForwardError(err: unknown, docId: string): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(ErrorCodes.QUERY_ROUTING_FAILED, String(err), { docId })
}

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

export async function applyForwardedBatch(
  payload: ForwardBatchPayload,
  deps: WriteRoutingDeps,
): Promise<ForwardBatchOperationResult[]> {
  const results: ForwardBatchOperationResult[] = new Array(payload.operations.length)
  const table = await deps.coordinator.getAllocation(payload.indexName)

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

  await Promise.all(
    Array.from(runsByPartition.entries()).map(async ([partitionId, runs]) => {
      for (const run of runs) {
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
  }
}
