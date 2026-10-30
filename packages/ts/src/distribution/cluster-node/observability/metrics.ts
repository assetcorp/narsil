import { workWaitingForMemory } from '../../../runtime/background-memory'
import type { ClusterCoordinator, PartitionAssignment } from '../../coordinator/types'
import type { ReplicationLog } from '../../replication/types'
import { acknowledgedSeqNoOf, keepAcknowledgementsOf } from '../catch-up/acknowledgements'
import { type CatchUpState, partitionKey } from '../catch-up/state'
import type {
  ClusterMetrics,
  CommitPointFigure,
  PartitionReplicationFigure,
  ReplicaLagFigure,
} from '../types/observability'
import type { CoordinatorTiming } from './coordinator-timing'
import { inSyncReplicasOf, servedIndexes } from './tables'

export interface ClusterMetricsDeps {
  nodeId: string
  coordinator: ClusterCoordinator
  catchUp: CatchUpState
  replicationLogOf: (indexName: string, partitionId: number) => ReplicationLog | undefined
  timing: CoordinatorTiming
}

function lagOf(
  deps: ClusterMetricsDeps,
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  log: ReplicationLog,
): ReplicaLagFigure[] {
  const figures: ReplicaLagFigure[] = []
  for (const replica of assignment.replicas) {
    if (replica === deps.nodeId) continue
    const acknowledged = acknowledgedSeqNoOf(deps.catchUp, indexName, partitionId, replica) ?? 0
    const floor = assignment.inSyncSet.includes(replica) ? log.commitPoint : 0
    const lag = Math.max(0, log.localLogEnd - Math.max(acknowledged, floor))
    figures.push({ indexName, partitionId, replica, lag })
  }
  return figures
}

export async function readClusterMetrics(deps: ClusterMetricsDeps): Promise<ClusterMetrics> {
  const replicationLag: ReplicaLagFigure[] = []
  const commitPoints: CommitPointFigure[] = []
  const partitions: PartitionReplicationFigure[] = []
  const ledPartitionKeys = new Set<string>()
  for (const index of await servedIndexes(deps.coordinator)) {
    if (index.table === null) continue
    const ordered = [...index.table.assignments.entries()].sort(([left], [right]) => left - right)
    for (const [partitionId, assignment] of ordered) {
      partitions.push({
        indexName: index.indexName,
        partitionId,
        commitPointFloor: assignment.commitPoint,
        inSyncReplicas: inSyncReplicasOf(assignment).length,
      })
      if (assignment.primary !== deps.nodeId) continue
      ledPartitionKeys.add(partitionKey(index.indexName, partitionId))
      const log = deps.replicationLogOf(index.indexName, partitionId)
      if (log === undefined) continue
      commitPoints.push({ indexName: index.indexName, partitionId, commitPoint: log.commitPoint })
      replicationLag.push(...lagOf(deps, index.indexName, partitionId, assignment, log))
    }
  }
  keepAcknowledgementsOf(deps.catchUp, ledPartitionKeys)
  return {
    replicationLag,
    commitPoints,
    partitions,
    coordinatorRequests: deps.timing.figures(),
    vectorRebuildsWaitingForMemory: workWaitingForMemory(),
  }
}
