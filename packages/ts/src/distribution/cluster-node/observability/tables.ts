import { HIDDEN_GENERATION_PREFIX } from '../../cluster/constants'
import { getIndexMetadata } from '../../cluster/index-metadata'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../coordinator/types'

export interface ServedIndex {
  indexName: string
  servingName: string
  partitionCount: number
  replicationFactor: number
  table: AllocationTable | null
}

async function servingTableOf(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<{ servingName: string; table: AllocationTable | null }> {
  const named = await coordinator.getAllocation(indexName)
  if (named?.generation === undefined) return { servingName: indexName, table: named }
  return { servingName: named.generation, table: await coordinator.getAllocation(named.generation) }
}

export async function servedIndexes(coordinator: ClusterCoordinator): Promise<ServedIndex[]> {
  const names = (await coordinator.listSchemas()).filter(name => !name.startsWith(HIDDEN_GENERATION_PREFIX)).sort()
  const served = await Promise.all(
    names.map(async (indexName): Promise<ServedIndex | null> => {
      const { servingName, table } = await servingTableOf(coordinator, indexName)
      if (table !== null && table.assignments.size > 0) {
        return {
          indexName,
          servingName,
          partitionCount: table.assignments.size,
          replicationFactor: table.replicationFactor,
          table,
        }
      }
      const servingMetadata = await getIndexMetadata(coordinator, servingName)
      const metadata =
        servingMetadata === null && servingName !== indexName
          ? await getIndexMetadata(coordinator, indexName)
          : servingMetadata
      if (metadata === null) return null
      return {
        indexName,
        servingName,
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
