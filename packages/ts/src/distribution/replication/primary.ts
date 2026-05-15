import type { NodeTransport, TransportMessage } from '../transport/types'
import { ReplicationMessageTypes, TransportError } from '../transport/types'
import { createEntryMessage } from './codec'
import type { ReplicateResult, ReplicationLogEntry } from './types'

export async function replicateToReplicas(
  entry: ReplicationLogEntry,
  inSyncReplicas: string[],
  transport: NodeTransport,
  sourceNodeId: string,
): Promise<ReplicateResult> {
  const uniqueReplicas = [...new Set(inSyncReplicas)]

  if (uniqueReplicas.length === 0) {
    return { acknowledged: [], failed: [] }
  }

  const message = createEntryMessage(entry, sourceNodeId)
  const sendResults = await Promise.allSettled(
    uniqueReplicas.map(replicaNodeId => sendToReplica(transport, replicaNodeId, message)),
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
    if (response.type === ReplicationMessageTypes.ACK) {
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
): Promise<TransportMessage> {
  return transport.send(replicaNodeId, message)
}
