import { ErrorCodes, NarsilError } from '../../errors'
import type { QueryCoverage } from '../../types/results'
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

const CODES_OF_A_LOST_LAYOUT: ReadonlySet<string> = new Set([
  ErrorCodes.INDEX_NOT_FOUND,
  ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
  ErrorCodes.QUERY_NODE_TIMEOUT,
  ErrorCodes.QUERY_PARTIAL_FAILURE,
  ErrorCodes.QUERY_ROUTING_FAILED,
])

export function leftOutAPartition(coverage: QueryCoverage): boolean {
  return coverage.totalPartitions === 0 || coverage.queriedPartitions < coverage.totalPartitions
}

export interface ServedRead {
  servingName: (indexName: string) => Promise<string>
  liveServingName: (indexName: string) => Promise<string>
}

export async function readFollowingTheName<T>(
  names: ServedRead,
  indexName: string,
  read: (servingName: string) => Promise<T>,
  answerIsPartial: (answer: T) => boolean = () => false,
): Promise<T> {
  const servingName = await names.servingName(indexName)
  const movedName = async (): Promise<string | null> => {
    const live = await names.liveServingName(indexName).catch(() => servingName)
    return live === servingName ? null : live
  }
  let answer: T
  try {
    answer = await read(servingName)
  } catch (error) {
    if (!(error instanceof NarsilError) || !CODES_OF_A_LOST_LAYOUT.has(error.code)) throw error
    const moved = await movedName()
    if (moved === null) throw error
    return read(moved)
  }
  if (!answerIsPartial(answer)) return answer
  const moved = await movedName()
  return moved === null ? answer : read(moved)
}
