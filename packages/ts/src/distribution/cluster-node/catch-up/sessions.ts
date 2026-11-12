import { generateId } from '../../../core/id-generator'
import { type CatchUpState, partitionKey, type SyncSession } from './state'

export function openSyncSession(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  primaryTerm: number,
  assignedNodeIds: readonly string[],
): string {
  const key = partitionKey(indexName, partitionId)
  const sessions = state.syncSessions.get(key) ?? new Map<string, SyncSession>()
  for (const [nodeId, session] of sessions) {
    if (session.primaryTerm !== primaryTerm || !assignedNodeIds.includes(nodeId)) sessions.delete(nodeId)
  }
  const id = generateId()
  sessions.set(replicaNodeId, { id, primaryTerm })
  state.syncSessions.set(key, sessions)
  return id
}

export function isCurrentSyncSession(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
  syncSession: string,
  primaryTerm: number,
): boolean {
  const session = state.syncSessions.get(partitionKey(indexName, partitionId))?.get(replicaNodeId)
  return session !== undefined && session.id === syncSession && session.primaryTerm === primaryTerm
}

export function forgetSyncSessions(state: CatchUpState, indexName: string, partitionId: number): void {
  state.syncSessions.delete(partitionKey(indexName, partitionId))
}
