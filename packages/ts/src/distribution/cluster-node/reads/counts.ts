import { ErrorCodes, NarsilError } from '../../../errors'
import type { IndexStats, PartitionStatsResult } from '../../../types/results'
import type { AllocationTable } from '../../coordinator/types'
import { createCountMessage, validateCountResultPayload } from '../../query/codec'
import type { PartitionCountEntry } from '../../transport/types'
import { routableAllocation } from '../routable-allocation'
import { localCountAnswer } from './count-answer'
import { countsOfEveryCopy, savedBytesWithVectors, sumOf } from './every-copy'
import { type ClusterReadDeps, gatherFromEveryPartition, sendReadRequest } from './scatter'

interface GatheredCounts {
  countsByPartition: Map<number, PartitionCountEntry>
  readBy: Map<number, string>
  language: string
}

async function gatherPartitionCounts(
  deps: ClusterReadDeps,
  indexName: string,
  allocation: AllocationTable,
): Promise<GatheredCounts> {
  const countsByPartition = new Map<number, PartitionCountEntry>()
  const readBy = new Map<number, string>()
  let language = ''

  const gathered = await gatherFromEveryPartition(allocation, indexName, async group => {
    if (group.nodeId === deps.nodeId) {
      return { nodeId: group.nodeId, answer: await localCountAnswer(deps.engine, indexName, group.partitionIds) }
    }
    const message = createCountMessage({ indexName, partitionIds: group.partitionIds }, deps.nodeId)
    const answer = await sendReadRequest(deps, group.nodeId, message, indexName, validateCountResultPayload)
    return { nodeId: group.nodeId, answer }
  })

  for (const { nodeId, answer } of gathered) {
    if (language.length === 0) {
      language = answer.language
    }
    for (const partition of answer.partitions) {
      countsByPartition.set(partition.partitionId, partition)
      readBy.set(partition.partitionId, nodeId)
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

  return { countsByPartition, readBy, language }
}

function figure(name: keyof IndexStats & keyof PartitionStatsResult, value: number | undefined) {
  return value === undefined ? {} : { [name]: value }
}

export async function countCluster(deps: ClusterReadDeps, indexName: string): Promise<number> {
  const allocation = await routableAllocation(deps.config.coordinator, indexName)
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
  const allocation = await routableAllocation(deps.config.coordinator, indexName)
  if (allocation === null) {
    return deps.engine.getStats(indexName)
  }

  const schema = await deps.config.coordinator.getSchema(indexName)
  if (schema === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' has no schema in the cluster`, {
      indexName,
    })
  }

  const { countsByPartition, readBy, language } = await gatherPartitionCounts(deps, indexName, allocation)
  const everyCopy = await countsOfEveryCopy(deps, indexName, allocation, countsByPartition, readBy)
  let documentCount = 0
  let estimatedMemoryBytes = 0
  for (const entry of countsByPartition.values()) {
    documentCount += entry.documentCount
    estimatedMemoryBytes += entry.estimatedMemoryBytes
  }
  const allCopies = everyCopy === null ? null : [...everyCopy.values()].flat()

  return {
    documentCount,
    partitionCount: allocation.assignments.size,
    estimatedMemoryBytes,
    ...figure('savedBytes', sumOf(countsByPartition.values(), savedBytesWithVectors)),
    ...figure(
      'logBytes',
      sumOf(countsByPartition.values(), entry => entry.logBytes),
    ),
    ...figure('savedBytesOfEveryCopy', allCopies === null ? undefined : sumOf(allCopies, savedBytesWithVectors)),
    ...figure('logBytesOfEveryCopy', allCopies === null ? undefined : sumOf(allCopies, entry => entry.logBytes)),
    language,
    schema,
  }
}

export async function partitionStatsCluster(deps: ClusterReadDeps, indexName: string): Promise<PartitionStatsResult[]> {
  const allocation = await routableAllocation(deps.config.coordinator, indexName)
  if (allocation === null) {
    return (await deps.engine.partitionStatsForRead(indexName)).partitions
  }
  const { countsByPartition, readBy } = await gatherPartitionCounts(deps, indexName, allocation)
  const everyCopy = await countsOfEveryCopy(deps, indexName, allocation, countsByPartition, readBy)
  return Array.from(countsByPartition.entries())
    .map(([partitionId, entry]) => {
      const copies = everyCopy?.get(partitionId)
      return {
        partitionId,
        documentCount: entry.documentCount,
        estimatedMemoryBytes: entry.estimatedMemoryBytes,
        ...figure('savedBytes', entry.savedBytes),
        ...figure('logBytes', entry.logBytes),
        ...figure('savedBytesOfEveryCopy', copies === undefined ? undefined : sumOf(copies, copy => copy.savedBytes)),
        ...figure('logBytesOfEveryCopy', copies === undefined ? undefined : sumOf(copies, copy => copy.logBytes)),
      }
    })
    .sort((a, b) => a.partitionId - b.partitionId)
}
