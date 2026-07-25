import { createReplicationLog } from '../replication/log'
import type { ReplicationLog } from '../replication/types'

export function replicationLogKey(indexName: string, partitionId: number): string {
  return `${indexName}:${partitionId}`
}

export function getReplicationLog(
  replicationLogs: Map<string, ReplicationLog>,
  indexName: string,
  partitionId: number,
): ReplicationLog {
  const key = replicationLogKey(indexName, partitionId)
  let log = replicationLogs.get(key)
  if (log === undefined) {
    log = createReplicationLog(partitionId)
    replicationLogs.set(key, log)
  }
  return log
}

export function seedReplicationLog(
  replicationLogs: Map<string, ReplicationLog>,
  indexName: string,
  partitionId: number,
  startSeqNo: number,
  lastPrimaryTerm = 0,
): void {
  replicationLogs.set(
    replicationLogKey(indexName, partitionId),
    createReplicationLog(partitionId, { startSeqNo, lastPrimaryTerm }),
  )
}
