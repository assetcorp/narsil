import { ErrorCodes, NarsilError } from '../../../errors'
import type { IndexStats, PartitionStatsResult } from '../../../types/results'
import type { AllocationTable } from '../../coordinator/types'
import { createCountMessage, validateCountResultPayload } from '../../query/codec'
import { activeAllocation, type ClusterReadDeps, sendReadRequest, strictScatterGroups } from './scatter'

interface GatheredCounts {
  countsByPartition: Map<number, { documentCount: number; estimatedMemoryBytes: number }>
  language: string
}

async function gatherPartitionCounts(
  deps: ClusterReadDeps,
  indexName: string,
  allocation: AllocationTable,
): Promise<GatheredCounts> {
  const groups = strictScatterGroups(allocation, deps.nodeId, indexName)
  const countsByPartition = new Map<number, { documentCount: number; estimatedMemoryBytes: number }>()
  let language = ''

  const gathered = await Promise.all(
    groups.map(async group => {
      if (group.nodeId === deps.nodeId) {
        const requested = new Set(group.partitionIds)
        const partitions = deps.engine
          .getPartitionStats(indexName)
          .filter(partition => requested.has(partition.partitionId))
          .map(partition => ({
            partitionId: partition.partitionId,
            documentCount: partition.documentCount,
            estimatedMemoryBytes: partition.estimatedMemoryBytes,
          }))
        return { partitions, language: deps.engine.getStats(indexName).language }
      }
      const message = createCountMessage({ indexName, partitionIds: group.partitionIds }, deps.nodeId)
      return sendReadRequest(deps, group.nodeId, message, indexName, validateCountResultPayload)
    }),
  )

  for (const result of gathered) {
    if (language.length === 0) {
      language = result.language
    }
    for (const partition of result.partitions) {
      countsByPartition.set(partition.partitionId, {
        documentCount: partition.documentCount,
        estimatedMemoryBytes: partition.estimatedMemoryBytes,
      })
    }
  }

  const missing: number[] = []
  for (const partitionId of allocation.assignments.keys()) {
    if (!countsByPartition.has(partitionId)) {
      missing.push(partitionId)
    }
  }
  if (missing.length > 0) {
    throw new NarsilError(
      ErrorCodes.QUERY_PARTIAL_FAILURE,
      `No node answered the count for one or more partitions of index '${indexName}'`,
      { indexName, partitionIds: missing.sort((a, b) => a - b) },
    )
  }

  return { countsByPartition, language }
}

export async function countCluster(deps: ClusterReadDeps, indexName: string): Promise<number> {
  const allocation = await activeAllocation(deps, indexName)
  if (allocation === null) {
    return deps.engine.countDocuments(indexName)
  }
  const { countsByPartition } = await gatherPartitionCounts(deps, indexName, allocation)
  let total = 0
  for (const entry of countsByPartition.values()) {
    total += entry.documentCount
  }
  return total
}

export async function statsCluster(deps: ClusterReadDeps, indexName: string): Promise<IndexStats> {
  const allocation = await activeAllocation(deps, indexName)
  if (allocation === null) {
    return deps.engine.getStats(indexName)
  }

  const schema = await deps.config.coordinator.getSchema(indexName)
  if (schema === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' has no schema in the cluster`, {
      indexName,
    })
  }

  const { countsByPartition, language } = await gatherPartitionCounts(deps, indexName, allocation)
  let documentCount = 0
  let estimatedMemoryBytes = 0
  for (const entry of countsByPartition.values()) {
    documentCount += entry.documentCount
    estimatedMemoryBytes += entry.estimatedMemoryBytes
  }

  return {
    documentCount,
    partitionCount: allocation.assignments.size,
    estimatedMemoryBytes,
    language,
    schema,
  }
}

export async function partitionStatsCluster(deps: ClusterReadDeps, indexName: string): Promise<PartitionStatsResult[]> {
  const allocation = await activeAllocation(deps, indexName)
  if (allocation === null) {
    return deps.engine.getPartitionStats(indexName)
  }
  const { countsByPartition } = await gatherPartitionCounts(deps, indexName, allocation)
  return Array.from(countsByPartition.entries())
    .map(([partitionId, entry]) => ({
      partitionId,
      documentCount: entry.documentCount,
      estimatedMemoryBytes: entry.estimatedMemoryBytes,
    }))
    .sort((a, b) => a.partitionId - b.partitionId)
}
