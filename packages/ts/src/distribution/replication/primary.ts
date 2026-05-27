import { decode } from '@msgpack/msgpack'
import type { NodeTransport, TransportMessage } from '../transport/types'
import { ReplicationMessageTypes, TransportError } from '../transport/types'
import { createEntryMessage, validateAckPayload } from './codec'
import type { ReplicateResult, ReplicationLogEntry } from './types'

export async function replicateToReplicas(
  entry: ReplicationLogEntry,
  inSyncReplicas: string[],
  transport: NodeTransport,
  sourceNodeId: string,
  resolveNodeTargets?: (nodeId: string) => Promise<string[]>,
): Promise<ReplicateResult> {
  const uniqueReplicas = [...new Set(inSyncReplicas)]

  if (uniqueReplicas.length === 0) {
    return { acknowledged: [], failed: [] }
  }

  const message = createEntryMessage(entry, sourceNodeId)
  const sendResults = await Promise.allSettled(
    uniqueReplicas.map(replicaNodeId => sendToReplica(transport, replicaNodeId, message, resolveNodeTargets)),
  )

  const acknowledged: string[] = []
  const failed: string[] = []

  for (let i = 0; i < sendResults.length; i++) {
    const result = sendResults[i]
    const replicaNodeId = uniqueReplicas[i]

    if (result.status === 'rejected') {
      if (result.reason instanceof TransportError) {
        failed.push(replicaNodeId)
        continue
      }
      throw result.reason
    }

    const response = result.value
    if (isMatchingAck(response, entry)) {
      acknowledged.push(replicaNodeId)
    } else {
      failed.push(replicaNodeId)
    }
  }

  return { acknowledged, failed }
}

async function sendToReplica(
  transport: NodeTransport,
  replicaNodeId: string,
  message: TransportMessage,
  resolveNodeTargets?: (nodeId: string) => Promise<string[]>,
): Promise<TransportMessage> {
  const targets = resolveNodeTargets === undefined ? [replicaNodeId] : await resolveNodeTargets(replicaNodeId)
  const resolvedTargets = targets.length > 0 ? targets : [replicaNodeId]
  let lastError: unknown

  for (const target of resolvedTargets) {
    try {
      return await transport.send(target, message)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function isMatchingAck(response: TransportMessage, entry: ReplicationLogEntry): boolean {
  if (response.type !== ReplicationMessageTypes.ACK) {
    return false
  }

  try {
    const payload = validateAckPayload(decode(response.payload))
    return (
      payload.seqNo === entry.seqNo &&
      payload.partitionId === entry.partitionId &&
      payload.indexName === entry.indexName
    )
  } catch {
    return false
  }
}
