import type { ClusterCoordinator, NodeRegistration } from '../../coordinator/types'
import type { NodeTransport } from '../../transport/types'

export type DataNodeLifecycleStatus = 'stopped' | 'joining' | 'active' | 'leaving' | 'shutdown'

export interface NodeLifecycleConfig {
  registration: NodeRegistration
  coordinator: ClusterCoordinator
  transport: NodeTransport
  knownIndexNames: string[]
  bootstrapRetryBaseMs: number
  bootstrapRetryMaxMs: number
  bootstrapMaxRetries: number
  allocationDebounceMs: number
  nodeHeartbeatIntervalMs: number
  onBootstrapPartition: (indexName: string, partitionId: number, primaryNodeId: string) => Promise<boolean>
  onRemovePartition?: (indexName: string, partitionId: number) => void
  onHoldPartition?: (indexName: string, partitionId: number) => void
  retainedPartitionIds?: (indexName: string) => number[]
  onPrimaryDemotion?: (indexName: string, partitionId: number, newPrimaryNodeId: string) => void
  onRegistered?: () => void
  onError?: (error: unknown) => void
}

export interface DataNodeHandle {
  readonly status: DataNodeLifecycleStatus
  readonly nodeId: string
  readonly registered: boolean
  readonly pendingPartitionCount: number
  join(): Promise<void>
  leave(): Promise<void>
  shutdown(): Promise<void>
}

export interface PartitionBootstrapState {
  indexName: string
  partitionId: number
  primaryNodeId: string
  retryCount: number
  retryTimer: ReturnType<typeof setTimeout> | null
  aborted: boolean
  abortResolve: (() => void) | null
}
