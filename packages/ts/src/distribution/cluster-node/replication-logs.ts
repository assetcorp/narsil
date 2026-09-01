import { createReplicationLog } from '../replication/log'
import type { ReplicationConfig, ReplicationLog } from '../replication/types'

export function replicationLogKey(indexName: string, partitionId: number): string {
  return `${indexName}:${partitionId}`
}

export function getReplicationLog(
  replicationLogs: Map<string, ReplicationLog>,
  indexName: string,
  partitionId: number,
  replicationConfig?: Partial<ReplicationConfig>,
): ReplicationLog {
  const key = replicationLogKey(indexName, partitionId)
  let log = replicationLogs.get(key)
  if (log === undefined) {
    log = createReplicationLog(partitionId, { logRetentionBytes: replicationConfig?.logRetentionBytes })
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
  replicationConfig?: Partial<ReplicationConfig>,
): void {
  replicationLogs.set(
    replicationLogKey(indexName, partitionId),
    createReplicationLog(partitionId, {
      startSeqNo,
      lastPrimaryTerm,
      logRetentionBytes: replicationConfig?.logRetentionBytes,
    }),
  )
}

/**
 * Removes every in-memory replication log owned by one index.
 *
 * @param replicationLogs - This node's local log registry.
 * @param indexName - The index whose logs are released.
 */
export function deleteIndexReplicationLogs(replicationLogs: Map<string, ReplicationLog>, indexName: string): void {
  const prefix = `${indexName}:`
  for (const key of replicationLogs.keys()) {
    if (key.startsWith(prefix)) replicationLogs.delete(key)
  }
}
