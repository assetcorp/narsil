import type { Narsil } from '../../../narsil'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../coordinator/types'
import type { ReplicationLog } from '../../replication/types'
import type { NodeTransport } from '../../transport/types'
import type { CatchUpState } from '../catch-up/state'
import type { NodeMemoryView } from '../memory/write-block'
import type { PartitionWriteQueues } from './partition-queue'

export interface WriteRoutingDeps {
  nodeId: string
  coordinator: ClusterCoordinator
  engine: Narsil
  transport: NodeTransport
  getReplicationLog: (indexName: string, partitionId: number) => ReplicationLog
  resetReplicationLog: (indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm?: number) => void
  partitionWriteQueues: PartitionWriteQueues
  catchUp: CatchUpState
  resolveNodeTargets?: (nodeId: string) => Promise<string[]>
  waitForActiveReplicas?: number
  memoryView?: NodeMemoryView
}

export interface PrimaryAssignmentResolution {
  table: AllocationTable
  partitionId: number
  assignment: PartitionAssignment & { primary: string }
}
