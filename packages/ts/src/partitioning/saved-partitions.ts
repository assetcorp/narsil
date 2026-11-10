import { ErrorCodes, NarsilError } from '../errors'
import { MAX_PARTITIONS } from './constants'

export function requireSavedPartitionCount(partitionCount: number, source: string, indexName: string): void {
  if (partitionCount <= MAX_PARTITIONS) return
  throw new NarsilError(
    ErrorCodes.PERSISTENCE_LOAD_FAILED,
    `The ${source} of index "${indexName}" holds partition ${partitionCount - 1}, and a saved index numbers its partitions from 0 to ${MAX_PARTITIONS - 1}`,
    { indexName, partitionId: partitionCount - 1, maxPartitions: MAX_PARTITIONS },
  )
}

export function highestPartitionIdOf(partitions: readonly { partitionId: number }[]): number {
  let highest = partitions.length - 1
  for (const partition of partitions) if (partition.partitionId > highest) highest = partition.partitionId
  return highest
}
