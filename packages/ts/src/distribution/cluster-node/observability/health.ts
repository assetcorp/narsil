import type { ClusterCoordinator } from '../../coordinator/types'
import type { ClusterHealth, ClusterHealthStatus, IndexHealth } from '../types/observability'
import { inSyncReplicasOf, type ServedIndex, servedIndexes } from './tables'

const STATUS_RANK: Record<ClusterHealthStatus, number> = { green: 0, yellow: 1, red: 2 }

function worse(left: ClusterHealthStatus, right: ClusterHealthStatus): ClusterHealthStatus {
  return STATUS_RANK[right] > STATUS_RANK[left] ? right : left
}

function healthOf(index: ServedIndex, registered: ReadonlySet<string>): IndexHealth {
  let partitionsWithoutPrimary = 0
  let underReplicatedPartitions = 0
  if (index.table === null) {
    partitionsWithoutPrimary = index.partitionCount
  } else {
    for (const assignment of index.table.assignments.values()) {
      if (assignment.primary === null || !registered.has(assignment.primary)) {
        partitionsWithoutPrimary += 1
        continue
      }
      const liveInSync = inSyncReplicasOf(assignment).filter(replica => registered.has(replica))
      if (assignment.state !== 'ACTIVE' || liveInSync.length < index.table.replicationFactor) {
        underReplicatedPartitions += 1
      }
    }
  }
  const status: ClusterHealthStatus =
    partitionsWithoutPrimary > 0 ? 'red' : underReplicatedPartitions > 0 ? 'yellow' : 'green'
  return {
    indexName: index.indexName,
    status,
    partitionCount: index.partitionCount,
    replicationFactor: index.replicationFactor,
    partitionsWithoutPrimary,
    underReplicatedPartitions,
  }
}

export async function readClusterHealth(coordinator: ClusterCoordinator): Promise<ClusterHealth> {
  const [served, nodes] = await Promise.all([servedIndexes(coordinator), coordinator.listNodes()])
  const registered = new Set(nodes.map(node => node.nodeId))
  const indexes = served.map(index => healthOf(index, registered))
  return {
    status: indexes.reduce<ClusterHealthStatus>((status, index) => worse(status, index.status), 'green'),
    indexes,
  }
}
