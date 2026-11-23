import { ErrorCodes, NarsilError } from '../../../errors'
import { encodeDocument } from '../../../serialization/document-encoding'
import type { AnyDocument } from '../../../types/schema'
import { chunkByBudget } from '../../chunking'
import { WIRE_BATCH_BUDGET } from '../../constants'
import { createForwardBatchMessage, validateForwardBatchResultPayload } from '../../replication/codec'
import type { ForwardBatchOperation, ForwardBatchPayload } from '../../transport/types'
import { forwardInterrupted, forwardUnsent, unsentAfter } from '../transport-failure'
import { abandonedWriteFrom, conditionFields, withAbandonedWrite } from './abandoned-write'
import type { BatchOutcome, BatchWrite, WriteFailure } from './batch-write'
import { requireOpenWindow, unsentAfterWindow, windowClosed, windowEndedOutcome } from './forward-window'
import {
  assertForwardResponse,
  forwardInsertToRemote,
  forwardRemoveToRemote,
  forwardUpdateToRemote,
  sendToNode,
} from './forwarding'
import { retriable } from './primary-change'
import type { WriteRoutingDeps } from './types'

export type ForwardedOperation = ForwardBatchOperation['operation']

interface OutgoingWrite<V> {
  write: BatchWrite<V>
  wire: ForwardBatchOperation
}

function toOutgoing<V extends AnyDocument | null>(
  operation: ForwardedOperation,
  write: BatchWrite<V>,
): OutgoingWrite<V> {
  const wire: ForwardBatchOperation = {
    documentId: write.docId,
    operation,
    document: write.value === null ? null : encodeDocument(write.value),
    updateFields: null,
    ...conditionFields(write.condition),
  }
  return { write, wire }
}

function chunkOutgoing<V>(outgoing: OutgoingWrite<V>[]): OutgoingWrite<V>[][] {
  return chunkByBudget(outgoing, {
    ...WIRE_BATCH_BUDGET,
    payloadBytesOf: ({ wire }) => wire.document?.byteLength ?? 0,
  })
}

async function forwardSingleWrite(
  indexName: string,
  operation: ForwardedOperation,
  write: BatchWrite<AnyDocument | null>,
  primaryNodeId: string,
  deps: WriteRoutingDeps,
  indexUuid: string | undefined,
  deadline: number,
): Promise<void> {
  const { docId, value, condition } = write
  if (operation === 'remove') {
    await forwardRemoveToRemote(indexName, docId, primaryNodeId, deps, deadline, indexUuid, condition)
    return
  }
  if (value === null) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `A forwarded ${operation} requires a document`, {
      documentId: docId,
    })
  }
  if (operation === 'insert') {
    await forwardInsertToRemote(indexName, value, docId, primaryNodeId, deps, deadline, indexUuid)
  } else {
    await forwardUpdateToRemote(indexName, value, docId, primaryNodeId, deps, deadline, indexUuid, condition)
  }
}

export interface ForwardTarget {
  primaryNodeId: string
  indexUuid: string | undefined
  deadline: number
}

export async function forwardBatchToRemote<V extends AnyDocument | null>(
  indexName: string,
  operation: ForwardedOperation,
  writes: BatchWrite<V>[],
  { primaryNodeId, indexUuid, deadline }: ForwardTarget,
  deps: WriteRoutingDeps,
): Promise<BatchOutcome<V>> {
  const succeeded: BatchWrite<V>[] = []
  const failed: WriteFailure<V>[] = []

  const [only] = writes
  if (only === undefined) {
    return { succeeded, failed }
  }

  if (windowClosed(deadline)) {
    return { succeeded, failed: unsentAfterWindow(indexName, writes) }
  }

  if (writes.length === 1) {
    try {
      await forwardSingleWrite(indexName, operation, only, primaryNodeId, deps, indexUuid, deadline)
      succeeded.push(only)
    } catch (err) {
      failed.push({ write: only, error: toForwardError(err, only.docId) })
    }
    return { succeeded, failed }
  }

  const awaitingRetry = new Map<string, NarsilError>()
  const refuse = (write: BatchWrite<V>, error: NarsilError): void => {
    failed.push({ write, error })
    if (retriable(error, operation === 'insert')) awaitingRetry.set(write.docId, error)
  }
  const outgoing: OutgoingWrite<V>[] = []
  for (const write of writes) {
    try {
      outgoing.push(toOutgoing(operation, write))
    } catch (err) {
      failed.push({ write, error: toForwardError(err, write.docId) })
    }
  }
  let undelivered: unknown
  for (const planned of chunkOutgoing(outgoing)) {
    if (windowClosed(deadline)) {
      for (const { write } of planned) failed.push({ write, error: windowEndedOutcome(indexName, write.docId) })
      continue
    }
    if (undelivered !== undefined) {
      for (const { write } of planned) failed.push({ write, error: toForwardError(undelivered, write.docId) })
      continue
    }
    let chunk = planned
    if (awaitingRetry.size > 0) {
      chunk = []
      for (const outgoing of planned) {
        const earlierRefusal = awaitingRetry.get(outgoing.write.docId)
        if (earlierRefusal === undefined) chunk.push(outgoing)
        else failed.push({ write: outgoing.write, error: earlierRefusal, withheld: true })
      }
      if (chunk.length === 0) continue
    }
    try {
      const operations = chunk.map(({ wire }) => wire)
      const payload: ForwardBatchPayload =
        indexUuid === undefined ? { indexName, operations } : { indexName, operations, indexUuid }
      const message = createForwardBatchMessage(payload, deps.nodeId)
      const response = await sendToNode(primaryNodeId, message, deps, () =>
        requireOpenWindow(deadline, indexName, only.docId),
      )
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
        const { write } = chunk[index]
        const operationResult = result.results[index]
        if (operationResult.documentId !== write.docId) {
          failed.push({
            write,
            error: new NarsilError(
              ErrorCodes.QUERY_ROUTING_FAILED,
              `Remote primary answered out of order for forwarded operation '${write.docId}'`,
              { indexName, primaryNodeId },
            ),
          })
          continue
        }
        if (operationResult.success) {
          succeeded.push(write)
          continue
        }
        const refusal = new NarsilError(
          operationResult.errorCode ?? ErrorCodes.QUERY_ROUTING_FAILED,
          operationResult.errorMessage ?? `Remote primary rejected forwarded operation '${write.docId}'`,
          { ...(operationResult.errorDetails ?? {}), indexName, primaryNodeId },
        )
        const abandonedWrite = abandonedWriteFrom(operationResult.abandonedWrite)
        refuse(write, abandonedWrite === undefined ? refusal : withAbandonedWrite(refusal, abandonedWrite))
      }
    } catch (err) {
      if (err instanceof NarsilError && (forwardUnsent(err) || forwardInterrupted(err))) undelivered = unsentAfter(err)
      for (const { write } of chunk) refuse(write, toForwardError(err, write.docId))
    }
  }

  return { succeeded, failed }
}

function toForwardError(err: unknown, docId: string): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(ErrorCodes.QUERY_ROUTING_FAILED, String(err), { docId })
}
