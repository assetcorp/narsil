import { HIDDEN_GENERATION_PREFIX } from '../../cluster/constants'
import { getIndexMetadata } from '../../cluster/index-metadata'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../coordinator/types'

export interface ServedIndex {
  indexName: string
  partitionCount: number
  replicationFactor: number
  table: AllocationTable | null
}

export async function servedIndexes(coordinator: ClusterCoordinator): Promise<ServedIndex[]> {
  const names = (await coordinator.listSchemas()).filter(name => !name.startsWith(HIDDEN_GENERATION_PREFIX)).sort()
  const served = await Promise.all(
    names.map(async (indexName): Promise<ServedIndex | null> => {
      const table = await coordinator.getAllocation(indexName)
      if (table !== null && table.assignments.size > 0) {
        return {
          indexName,
          partitionCount: table.assignments.size,
          replicationFactor: table.replicationFactor,
          table,
        }
      }
      const metadata = await getIndexMetadata(coordinator, indexName)
      if (metadata === null) return null
      return {
        indexName,
        partitionCount: metadata.partitionCount,
        replicationFactor: metadata.replicationFactor,
        table: null,
      }
    }),
  )
  return served.filter((index): index is ServedIndex => index !== null)
}

export function inSyncReplicasOf(assignment: PartitionAssignment): string[] {
  return assignment.replicas.filter(replica => replica !== assignment.primary && assignment.inSyncSet.includes(replica))
}
