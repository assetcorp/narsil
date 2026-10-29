import { type CatchUpState, partitionKey } from './state'

export function recordAcknowledgements(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeIds: string[],
  seqNo: number,
): void {
  if (replicaNodeIds.length === 0) return
  const key = partitionKey(indexName, partitionId)
  const acknowledged = state.acknowledgedSeqNos.get(key) ?? new Map<string, number>()
  for (const replicaNodeId of replicaNodeIds) {
    if ((acknowledged.get(replicaNodeId) ?? 0) < seqNo) acknowledged.set(replicaNodeId, seqNo)
  }
  state.acknowledgedSeqNos.set(key, acknowledged)
}

export function acknowledgedSeqNoOf(
  state: CatchUpState,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): number | undefined {
  const key = partitionKey(indexName, partitionId)
  const acknowledged = state.acknowledgedSeqNos.get(key)?.get(replicaNodeId)
  const cursor = state.cursors.get(key)?.get(replicaNodeId)?.appliedSeqNo
  if (acknowledged === undefined) return cursor
  if (cursor === undefined) return acknowledged
  return Math.max(acknowledged, cursor)
}

export function keepAcknowledgementsOf(state: CatchUpState, ledPartitionKeys: ReadonlySet<string>): void {
  for (const key of [...state.acknowledgedSeqNos.keys()]) {
    if (!ledPartitionKeys.has(key)) state.acknowledgedSeqNos.delete(key)
  }
}
