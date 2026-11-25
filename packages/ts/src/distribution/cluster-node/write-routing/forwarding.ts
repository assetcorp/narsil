import { ErrorCodes, NarsilError } from '../../../errors'
import { encodeDocument } from '../../../serialization/document-encoding'
import { decode } from '../../../serialization/msgpack'
import type { AnyDocument } from '../../../types/schema'
import { createForwardMessage } from '../../replication/codec'
import { refuseCarrierFailure } from '../../transport/carrier-error'
import type { ForwardPayload, NodeTransport, TransportMessage, WriteCondition } from '../../transport/types'
import { remoteErrorDetails } from '../error-reply'
import { sendUntilMaybeDelivered } from '../transport-failure'
import { abandonedWriteFrom, conditionFields, withAbandonedWrite } from './abandoned-write'
import { resolveNodeTargets } from './assignment'
import {
  type AttemptWindow,
  attemptWindowClosed,
  beforeAttemptEnds,
  unsentWindowEndedOutcome,
  WINDOW_ENDED,
  windowEndedOutcome,
} from './forward-window'
import type { WriteRoutingDeps } from './types'

export function assertForwardResponse(
  response: TransportMessage,
  indexName: string,
  primaryNodeId: string,
): Record<string, unknown> {
  const decoded = decode(response.payload) as Record<string, unknown>
  if (response.type.endsWith('.error') || response.type === 'error' || decoded.error === true) {
    const refusal = new NarsilError(
      typeof decoded.code === 'string' ? decoded.code : ErrorCodes.QUERY_ROUTING_FAILED,
      typeof decoded.message === 'string'
        ? decoded.message
        : `Remote primary rejected a forwarded write for index '${indexName}'`,
      { ...remoteErrorDetails(decoded.details), indexName, primaryNodeId },
    )
    const abandonedWrite = abandonedWriteFrom(decoded.abandonedWrite)
    throw abandonedWrite === undefined ? refusal : withAbandonedWrite(refusal, abandonedWrite)
  }
  return decoded
}

export async function forwardInsertToRemote(
  indexName: string,
  document: AnyDocument,
  docId: string,
  primaryNodeId: string,
  deps: WriteRoutingDeps,
  window: AttemptWindow,
  indexUuid?: string,
): Promise<string> {
  const payload: ForwardPayload = {
    indexName,
    documentId: docId,
    operation: 'insert',
    document: encodeDocument(document),
    updateFields: null,
  }
  if (indexUuid !== undefined) payload.indexUuid = indexUuid
  const message = createForwardMessage(payload, deps.nodeId)
  const response = await sendToNode(primaryNodeId, message, deps, window, windowEndedFor(indexName, docId, deps))
  const decoded = assertForwardResponse(response, indexName, primaryNodeId)
  if (typeof decoded.documentId !== 'string') {
    throw new NarsilError(
      ErrorCodes.QUERY_ROUTING_FAILED,
      `Remote primary returned invalid forward response for index '${indexName}'`,
      { indexName, primaryNodeId },
    )
  }
  return decoded.documentId
}

export async function forwardUpdateToRemote(
  indexName: string,
  document: AnyDocument,
  docId: string,
  primaryNodeId: string,
  deps: WriteRoutingDeps,
  window: AttemptWindow,
  indexUuid?: string,
  condition?: WriteCondition,
): Promise<void> {
  const payload: ForwardPayload = {
    indexName,
    documentId: docId,
    operation: 'update',
    document: encodeDocument(document),
    updateFields: null,
    ...conditionFields(condition),
  }
  if (indexUuid !== undefined) payload.indexUuid = indexUuid
  const message = createForwardMessage(payload, deps.nodeId)
  const response = await sendToNode(primaryNodeId, message, deps, window, windowEndedFor(indexName, docId, deps))
  assertForwardResponse(response, indexName, primaryNodeId)
}

export async function forwardRemoveToRemote(
  indexName: string,
  docId: string,
  primaryNodeId: string,
  deps: WriteRoutingDeps,
  window: AttemptWindow,
  indexUuid?: string,
  condition?: WriteCondition,
): Promise<void> {
  const payload: ForwardPayload = {
    indexName,
    documentId: docId,
    operation: 'remove',
    document: null,
    updateFields: null,
    ...conditionFields(condition),
  }
  if (indexUuid !== undefined) payload.indexUuid = indexUuid
  const message = createForwardMessage(payload, deps.nodeId)
  const response = await sendToNode(primaryNodeId, message, deps, window, windowEndedFor(indexName, docId, deps))
  assertForwardResponse(response, indexName, primaryNodeId)
}

export type WindowEndedAnswer = (sent: boolean) => NarsilError

function windowEndedFor(indexName: string, docId: string, deps: WriteRoutingDeps): WindowEndedAnswer {
  return sent =>
    sent
      ? windowEndedOutcome(indexName, docId, deps.shutdownSignal)
      : unsentWindowEndedOutcome(indexName, docId, deps.shutdownSignal)
}

export async function sendToNode(
  nodeId: string,
  message: ReturnType<typeof createForwardMessage>,
  deps: WriteRoutingDeps,
  window: AttemptWindow,
  windowEnded: WindowEndedAnswer,
): Promise<Awaited<ReturnType<NodeTransport['send']>>> {
  const resolving = resolveNodeTargets(nodeId, deps)
  const targets = window.started ? await beforeAttemptEnds(resolving, window, deps.shutdownSignal) : await resolving
  if (targets === WINDOW_ENDED) throw windowEnded(false)
  const send = async (target: string) => {
    if (attemptWindowClosed(window, deps.shutdownSignal)) throw windowEnded(false)
    window.started = true
    const answer = await beforeAttemptEnds(deps.transport.send(target, message), window, deps.shutdownSignal)
    if (answer === WINDOW_ENDED) throw windowEnded(true)
    return refuseCarrierFailure(answer, target)
  }
  return sendUntilMaybeDelivered(targets, send, {
    message: `Node '${nodeId}' did not answer a forwarded write`,
    details: { targetNodeId: nodeId },
  })
}
