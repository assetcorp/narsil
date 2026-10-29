import { ErrorCodes, NarsilError } from '../../../errors'
import { encodeDocument } from '../../../serialization/document-encoding'
import type { BatchResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import { chunkByBudget } from '../../chunking'
import { WIRE_BATCH_BUDGET } from '../../constants'
import { createForwardBatchMessage, validateForwardBatchResultPayload } from '../../replication/codec'
import type { ForwardBatchOperation, ForwardBatchPayload } from '../../transport/types'
import { forwardUndelivered } from '../transport-failure'
import {
  assertForwardResponse,
  forwardInsertToRemote,
  forwardRemoveToRemote,
  forwardUpdateToRemote,
  sendToNode,
} from './forwarding'
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
    document: item.document === null ? null : encodeDocument(item.document),
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
  indexUuid: string | undefined,
): Promise<string> {
  if (item.operation === 'insert') {
    if (item.document === null) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A forwarded insert requires a document', {
        documentId: item.documentId,
      })
    }
    return forwardInsertToRemote(indexName, item.document, item.documentId, primaryNodeId, deps, indexUuid)
  }
  if (item.operation === 'update') {
    if (item.document === null) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A forwarded update requires a document', {
        documentId: item.documentId,
      })
    }
    await forwardUpdateToRemote(indexName, item.document, item.documentId, primaryNodeId, deps, indexUuid)
    return item.documentId
  }
  await forwardRemoveToRemote(indexName, item.documentId, primaryNodeId, deps, indexUuid)
  return item.documentId
}

export async function forwardBatchToRemote(
  indexName: string,
  items: ForwardBatchItem[],
  primaryNodeId: string,
  deps: WriteRoutingDeps,
  indexUuid?: string,
): Promise<BatchResult> {
  const succeeded: string[] = []
  const failed: BatchResult['failed'] = []

  if (items.length === 0) {
    return { succeeded, failed }
  }

  if (items.length === 1) {
    try {
      succeeded.push(await forwardSingleItem(indexName, items[0], primaryNodeId, deps, indexUuid))
    } catch (err) {
      failed.push({ docId: items[0].documentId, error: toForwardError(err, items[0].documentId) })
    }
    return { succeeded, failed }
  }

  const chunks = chunkWireOperations(items.map(toWireOperation))
  let undelivered: unknown
  for (const chunk of chunks) {
    if (undelivered !== undefined) {
      for (const operation of chunk) {
        failed.push({ docId: operation.documentId, error: toForwardError(undelivered, operation.documentId) })
      }
      continue
    }
    try {
      const payload: ForwardBatchPayload =
        indexUuid === undefined ? { indexName, operations: chunk } : { indexName, operations: chunk, indexUuid }
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
            { ...(operationResult.errorDetails ?? {}), indexName, primaryNodeId },
          ),
        })
      }
    } catch (err) {
      if (forwardUndelivered(err)) undelivered = err
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
