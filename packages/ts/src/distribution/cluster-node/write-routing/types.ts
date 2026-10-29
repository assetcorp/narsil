import type { Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../coordinator/types'
import type { ReplicationLog } from '../../replication/types'
import type { NodeTransport } from '../../transport/types'
import type { CatchUpState } from '../catch-up/state'
import type { NodeMemoryView } from '../memory/write-block'
import type { WritePressure } from '../memory/write-pressure'
import type { WriteProjection } from '../memory/write-projection'
import type { ReshardState } from '../reshard/state'
import type { PrimaryNumbering } from './numbering'
import type { PartitionWriteQueues } from './partition-queue'

export interface WriteRoutingDeps {
  nodeId: string
  coordinator: ClusterCoordinator
  refreshAllocation?: (indexName: string) => Promise<AllocationTable | null>
  readLiveAllocation?: (indexName: string) => Promise<AllocationTable | null>
  readPrimaryCopies?: (indexName: string, docIds: readonly string[]) => Promise<Map<string, AnyDocument>>
  engine: Narsil
  transport: NodeTransport
  getReplicationLog: (indexName: string, partitionId: number) => ReplicationLog
  resetReplicationLog: (indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm?: number) => void
  partitionWriteQueues: PartitionWriteQueues
  numbering?: PrimaryNumbering
  commitPartitionLog?: (indexName: string, partitionId: number) => Promise<void>
  catchUp: CatchUpState
  resolveNodeTargets?: (nodeId: string) => Promise<string[]>
  waitForActiveReplicas?: number
  memoryView?: NodeMemoryView
  writePressure?: WritePressure
  writeProjection?: WriteProjection
  reshard?: ReshardState
  copyFailed?: (indexName: string, partitionId: number) => boolean
  copyUnlisted?: (indexName: string, partitionId: number) => boolean
}

export interface PrimaryAssignmentResolution {
  table: AllocationTable
  partitionId: number
  assignment: PartitionAssignment & { primary: string }
}
