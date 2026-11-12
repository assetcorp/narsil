import { ErrorCodes } from '../../errors'
import { decode } from '../../serialization/msgpack'
import { isRecord } from '../payload-guards'
import type { NodeTransport, TransportMessage } from '../transport/types'
import { ReplicationMessageTypes, TransportError, TransportErrorCodes } from '../transport/types'
import { createEntryBatchMessage, createEntryMessage, validateAckPayload } from './codec'
import type { ReplicateResult, ReplicationLog, ReplicationLogEntry } from './types'

export function previousTermOf(log: ReplicationLog, seqNo: number): number | undefined {
  return seqNo <= 1 ? 0 : log.termAt(seqNo - 1)
}

export async function replicateToReplicas(
  entry: ReplicationLogEntry,
  inSyncReplicas: string[],
  transport: NodeTransport,
  sourceNodeId: string,
  resolveNodeTargets?: (nodeId: string) => Promise<string[]>,
  indexUuid?: string,
  previousPrimaryTerm?: number,
): Promise<ReplicateResult> {
  const message = createEntryMessage(entry, sourceNodeId, indexUuid, previousPrimaryTerm)
  return sendAndCollectAcks(message, entry, inSyncReplicas, transport, resolveNodeTargets)
}

export async function replicateBatchToReplicas(
  entries: ReplicationLogEntry[],
  inSyncReplicas: string[],
  transport: NodeTransport,
  sourceNodeId: string,
  resolveNodeTargets?: (nodeId: string) => Promise<string[]>,
  indexUuid?: string,
  previousPrimaryTerm?: number,
): Promise<ReplicateResult> {
  if (entries.length === 0) {
    return { acknowledged: [], failed: [], refusedAsInvalid: [] }
  }
  if (entries.length === 1) {
    return replicateToReplicas(
      entries[0],
      inSyncReplicas,
      transport,
      sourceNodeId,
      resolveNodeTargets,
      indexUuid,
      previousPrimaryTerm,
    )
  }

  const message = createEntryBatchMessage(entries, sourceNodeId, indexUuid, previousPrimaryTerm)
  const lastEntry = entries[entries.length - 1]
  return sendAndCollectAcks(message, lastEntry, inSyncReplicas, transport, resolveNodeTargets)
}

async function sendAndCollectAcks(
  message: TransportMessage,
  ackEntry: ReplicationLogEntry,
  inSyncReplicas: string[],
  transport: NodeTransport,
  resolveNodeTargets?: (nodeId: string) => Promise<string[]>,
): Promise<ReplicateResult> {
  const uniqueReplicas = [...new Set(inSyncReplicas)]

  if (uniqueReplicas.length === 0) {
    return { acknowledged: [], failed: [], refusedAsInvalid: [] }
  }

  const sendResults = await Promise.allSettled(
    uniqueReplicas.map(replicaNodeId => sendToReplica(transport, replicaNodeId, message, resolveNodeTargets)),
  )

  const acknowledged: string[] = []
  const failed: string[] = []
  const refusedAsInvalid: string[] = []

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
    if (isMatchingAck(response, ackEntry)) {
      acknowledged.push(replicaNodeId)
    } else {
      failed.push(replicaNodeId)
      if (refusesAsInvalid(response)) refusedAsInvalid.push(replicaNodeId)
    }
  }

  return { acknowledged, failed, refusedAsInvalid }
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
      if (error instanceof TransportError && error.code === TransportErrorCodes.TIMEOUT) {
        throw error
      }
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function refusesAsInvalid(response: TransportMessage): boolean {
  if (!response.type.endsWith('.error')) return false
  try {
    const payload = decode(response.payload)
    return isRecord(payload) && payload.code === ErrorCodes.REPLICATION_ENTRY_INVALID
  } catch (_) {
    return false
  }
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
