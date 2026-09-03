import type { ClusterCoordinator } from '../../coordinator/types'
import {
  SNAPSHOT_HEADER_SENTINEL_PARTITION_ID,
  SNAPSHOT_HEADER_SENTINEL_SEQNO,
} from '../../replication/snapshot-constants'

import type { SnapshotHeaderMetadata, SnapshotSyncHandlerDeps } from './types'

export async function defaultSnapshotHeaderMetadataProvider(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<SnapshotHeaderMetadata> {
  try {
    const allocation = await coordinator.getAllocation(indexName)
    if (allocation !== null) {
      for (const assignment of allocation.assignments.values()) {
        if (Number.isInteger(assignment.primaryTerm) && assignment.primaryTerm >= 0) {
          return {
            partitionId: SNAPSHOT_HEADER_SENTINEL_PARTITION_ID,
            primaryTerm: assignment.primaryTerm,
            lastSeqNo: SNAPSHOT_HEADER_SENTINEL_SEQNO,
          }
        }
      }
    }
  } catch (_) {}
  return {
    partitionId: SNAPSHOT_HEADER_SENTINEL_PARTITION_ID,
    primaryTerm: 0,
    lastSeqNo: SNAPSHOT_HEADER_SENTINEL_SEQNO,
  }
}

export async function resolveHeaderMetadata(
  deps: SnapshotSyncHandlerDeps,
  indexName: string,
  partitionId: number | null,
): Promise<SnapshotHeaderMetadata> {
  const provider = deps.resolveHeaderMetadata
  if (provider === undefined) {
    return defaultSnapshotHeaderMetadataProvider(deps.coordinator, indexName)
  }
  try {
    return await provider(indexName, partitionId)
  } catch (_) {
    return {
      partitionId: SNAPSHOT_HEADER_SENTINEL_PARTITION_ID,
      primaryTerm: 0,
      lastSeqNo: SNAPSHOT_HEADER_SENTINEL_SEQNO,
    }
  }
}
