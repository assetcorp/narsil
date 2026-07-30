import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import { createForwardMessage } from '../../replication/codec'
import type { ForwardPayload, NodeTransport } from '../../transport/types'
import { resolveNodeTargets } from './assignment'
import type { WriteRoutingDeps } from './types'

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
  const decoded = decode(response.payload) as Record<string, unknown>
  if (typeof decoded.documentId !== 'string') {
    throw new NarsilError(
      ErrorCodes.QUERY_ROUTING_FAILED,
      `Remote primary returned invalid forward response for index '${indexName}'`,
      { indexName, primaryNodeId },
    )
  }
  return decoded.documentId
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
  await sendToNode(primaryNodeId, message, deps)
}

export async function sendToNode(
  nodeId: string,
  message: ReturnType<typeof createForwardMessage>,
  deps: WriteRoutingDeps,
): Promise<Awaited<ReturnType<NodeTransport['send']>>> {
  const targets = await resolveNodeTargets(nodeId, deps)
  let lastError: unknown
  for (const target of targets) {
    try {
      return await deps.transport.send(target, message)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
