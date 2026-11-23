import type { NarsilError } from '../../../errors'
import { isHiddenGeneration } from '../../cluster/rebalance/records'
import type { AllocationTable } from '../../coordinator/types'
import { publicNameOf, rebalancingBackpressure } from '../reshard/block'
import { resolvePartitionId } from './assignment'
import type { WriteRoutingDeps } from './types'

export type ForwardedName =
  | { kind: 'served'; indexName: string }
  | { kind: 'blocked'; refusal: (documentId: string) => NarsilError }

function blockedPartitionsOf(deps: WriteRoutingDeps, indexName: string): number[] {
  const blocks = deps.reshard?.blocks
  if (blocks === undefined) return []
  const prefix = `${indexName}:`
  const partitions: number[] = []
  for (const [key, block] of blocks) {
    if (key.startsWith(prefix)) partitions.push(block.partitionId)
  }
  return partitions.sort((left, right) => left - right)
}

function heldPartitionCount(deps: WriteRoutingDeps, indexName: string): number | null {
  try {
    return deps.engine.getStats(indexName).partitionCount
  } catch (_) {
    return null
  }
}

async function servingGenerationOf(
  deps: WriteRoutingDeps,
  indexName: string,
  table: AllocationTable | null,
): Promise<string> {
  if (table?.generation !== undefined) return table.generation
  if (deps.reshard === undefined || !isHiddenGeneration(indexName)) return indexName
  const publicName = await publicNameOf(deps.reshard, deps.coordinator, indexName)
  if (publicName === null) return indexName
  return (await deps.coordinator.getAllocation(publicName))?.generation ?? publicName
}

export async function nameOfForwardedWrite(indexName: string, deps: WriteRoutingDeps): Promise<ForwardedName> {
  const table = await deps.coordinator.getAllocation(indexName)
  if (table !== null && table.assignments.size > 0) return { kind: 'served', indexName }
  const blocked = blockedPartitionsOf(deps, indexName)
  const firstBlocked = blocked[0]
  if (firstBlocked === undefined) {
    return { kind: 'served', indexName: await servingGenerationOf(deps, indexName, table) }
  }
  const partitionCount = heldPartitionCount(deps, indexName)
  return {
    kind: 'blocked',
    refusal: documentId => {
      const routed = partitionCount === null ? firstBlocked : resolvePartitionId(documentId, partitionCount)
      return rebalancingBackpressure(indexName, blocked.includes(routed) ? routed : firstBlocked)
    },
  }
}
