import type {
  AllocationConstraints,
  AllocationTable,
  NodeRegistration,
  PartitionAssignment,
} from '../../coordinator/types'

export type DeciderVerdict = 'YES' | 'NO' | 'THROTTLE'

export interface DeciderContext {
  partitionId: number
  role: 'primary' | 'replica'
  candidateNodeId: string
  currentAssignment: PartitionAssignment | undefined
  allAssignments: Map<number, PartitionAssignment>
  nodeAssignmentCounts: Map<string, number>
  nodes: Map<string, NodeRegistration>
  constraints: AllocationConstraints
}

export interface Decider {
  name: string
  canAllocate(context: DeciderContext): DeciderVerdict
}

export interface NodeWeight {
  nodeId: string
  weight: number
  partitionCount: number
  capacity: number
}

export interface AllocationMove {
  partitionId: number
  role: 'primary' | 'replica'
  fromNodeId: string
  toNodeId: string
}

export interface AllocationResult {
  table: AllocationTable
  warnings: string[]
}

export type { AllocationConstraints, AllocationTable, NodeRegistration, PartitionAssignment }

export const REBALANCE_THRESHOLD = 0.1

export const DEFAULT_ESTIMATED_PARTITION_BYTES = 50 * 1024 * 1024
