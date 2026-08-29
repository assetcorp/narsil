import { ErrorCodes, NarsilError } from '../../errors'
import { getIndexMetadata } from '../cluster/index-metadata'
import type { AllocationTable, ClusterCoordinator } from '../coordinator/types'

/**
 * Gives the allocation table a read or a write must route through, and refuses where the cluster owns the index
 * and has yet to allocate it.
 *
 * A node answers from its own copy only for an index the coordinator holds no metadata for. The node serves an index
 * the cluster owns through its allocation table alone, so it refuses a request that arrives before the controller
 * has allocated the index. That refusal keeps one node's copy from taking a write no reader would find.
 *
 * @param coordinator - The coordinator holding the cluster's allocation tables and index metadata.
 * @param indexName - The index the caller is about to read or write.
 * @returns The allocation table, or `null` where the coordinator holds no metadata for the index.
 * @throws A {@link NarsilError} carrying `QUERY_ROUTING_FAILED` where the coordinator holds metadata for the index
 * and no allocation table with at least one partition.
 */
export async function routableAllocation(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<AllocationTable | null> {
  const table = await coordinator.getAllocation(indexName)
  if (table !== null && table.assignments.size > 0) {
    return table
  }

  if ((await getIndexMetadata(coordinator, indexName)) === null) {
    return null
  }

  throw new NarsilError(
    ErrorCodes.QUERY_ROUTING_FAILED,
    `The cluster owns index '${indexName}' and holds no allocation table for it yet, so this node cannot place a read or a write`,
    { indexName },
  )
}
