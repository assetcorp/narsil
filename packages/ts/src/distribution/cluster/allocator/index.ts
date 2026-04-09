import { ErrorCodes, NarsilError } from '../../../errors'
import type { AllocationConstraints, AllocationTable, NodeRegistration } from '../../coordinator/types'
import { createDeciderChain } from './deciders'
import { initialAllocate } from './initial'
import { rebalanceAllocate } from './rebalance'

export function allocate(
  nodes: NodeRegistration[],
  currentTable: AllocationTable | null,
  indexName: string,
  partitionCount: number,
  replicationFactor: number,
  constraints: AllocationConstraints,
): AllocationTable {
  if (partitionCount <= 0) {
    throw new NarsilError(ErrorCodes.ALLOCATION_INVALID_CONFIG, 'partitionCount must be greater than 0', {
      partitionCount,
    })
  }

  if (replicationFactor < 0) {
    throw new NarsilError(ErrorCodes.ALLOCATION_INVALID_CONFIG, 'replicationFactor must be 0 or greater', {
      replicationFactor,
    })
  }

  const dataNodes = nodes.filter(n => n.roles.includes('data'))

  if (dataNodes.length === 0) {
    throw new NarsilError(ErrorCodes.ALLOCATION_NO_DATA_NODES, 'No data nodes available for allocation', {
      totalNodes: nodes.length,
    })
  }

  const deciders = createDeciderChain(constraints)

  if (currentTable === null) {
    return initialAllocate(dataNodes, indexName, partitionCount, replicationFactor, constraints, deciders)
  }

  return rebalanceAllocate(dataNodes, currentTable, constraints, deciders)
}

export type { AllocationConstraints, AllocationTable, NodeRegistration }
export { createDeciderChain, runDeciders } from './deciders'
export { initialAllocate } from './initial'
export { rebalanceAllocate } from './rebalance'
export type { AllocationMove, Decider, DeciderContext, DeciderVerdict, NodeWeight } from './types'
export { DEFAULT_ESTIMATED_PARTITION_BYTES, REBALANCE_THRESHOLD } from './types'
export { computeNodeWeights, countNodeAssignments, findBestNode } from './weight'
