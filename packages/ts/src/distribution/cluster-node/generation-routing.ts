import { ErrorCodes, NarsilError } from '../../errors'
import { isHiddenGeneration } from '../cluster/rebalance/records'
import type { ClusterCoordinator } from '../coordinator/types'

export function refuseHiddenGeneration(indexName: string): void {
  if (isHiddenGeneration(indexName)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `Index names that start with 'narsil-generation-' are reserved for partition count changes`,
      { indexName },
    )
  }
}

export async function servingNameOf(coordinator: Pick<ClusterCoordinator, 'getAllocation'>, indexName: string) {
  refuseHiddenGeneration(indexName)
  const table = await coordinator.getAllocation(indexName)
  return table?.generation ?? indexName
}
