import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import { createForwardMessage } from '../../replication/codec'
import type { ForwardPayload, NodeTransport, TransportMessage } from '../../transport/types'
import { sendThroughTargets } from '../transport-failure'
import { resolveNodeTargets } from './assignment'
import type { WriteRoutingDeps } from './types'

export function assertForwardResponse(
  response: TransportMessage,
  indexName: string,
  primaryNodeId: string,
): Record<string, unknown> {
  const decoded = decode(response.payload) as Record<string, unknown>
  if (response.type.endsWith('.error') || response.type === 'error' || decoded.error === true) {
    throw new NarsilError(
      typeof decoded.code === 'string' ? decoded.code : ErrorCodes.QUERY_ROUTING_FAILED,
      typeof decoded.message === 'string'
        ? decoded.message
        : `Remote primary rejected a forwarded write for index '${indexName}'`,
      { indexName, primaryNodeId },
    )
  }
  return decoded
}

export async function forwardInsertToRemote(
  indexName: string,
  document: AnyDocument,
  docId: string,
  primaryNodeId: string,
  deps: WriteRoutingDeps,
): Promise<string> {
  const payload: ForwardPayload = {
    indexName,
    documentId: docId,
    operation: 'insert',
    document: encode(document),
    updateFields: null,
  }
  const message = createForwardMessage(payload, deps.nodeId)
  const response = await sendToNode(primaryNodeId, message, deps)
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
): Promise<void> {
  const payload: ForwardPayload = {
    indexName,
    documentId: docId,
    operation: 'update',
    document: encode(document),
    updateFields: null,
  }
  const message = createForwardMessage(payload, deps.nodeId)
  const response = await sendToNode(primaryNodeId, message, deps)
  assertForwardResponse(response, indexName, primaryNodeId)
}

export async function forwardRemoveToRemote(
  indexName: string,
  docId: string,
  primaryNodeId: string,
  deps: WriteRoutingDeps,
): Promise<void> {
  const payload: ForwardPayload = {
    indexName,
    documentId: docId,
    operation: 'remove',
    document: null,
    updateFields: null,
  }
  const message = createForwardMessage(payload, deps.nodeId)
  const response = await sendToNode(primaryNodeId, message, deps)
  assertForwardResponse(response, indexName, primaryNodeId)
}

export async function sendToNode(
  nodeId: string,
  message: ReturnType<typeof createForwardMessage>,
  deps: WriteRoutingDeps,
): Promise<Awaited<ReturnType<NodeTransport['send']>>> {
  const targets = await resolveNodeTargets(nodeId, deps)
  return sendThroughTargets(targets, target => deps.transport.send(target, message), {
    message: `Node '${nodeId}' did not answer a forwarded write`,
    details: { targetNodeId: nodeId },
  })
}
