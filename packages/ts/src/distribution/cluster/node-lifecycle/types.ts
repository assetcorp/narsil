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
  onBootstrapPartition: (indexName: string, partitionId: number, primaryNodeId: string) => Promise<boolean>
  onRemovePartition?: (indexName: string, partitionId: number) => void
  onPrimaryDemotion?: (indexName: string, partitionId: number, newPrimaryNodeId: string) => void
  onError?: (error: unknown) => void
}

export const DEFAULT_NODE_LIFECYCLE_CONFIG = {
  bootstrapRetryBaseMs: 1_000,
  bootstrapRetryMaxMs: 30_000,
  bootstrapMaxRetries: 10,
  allocationDebounceMs: 250,
} as const

export interface DataNodeHandle {
  readonly status: DataNodeLifecycleStatus
  readonly nodeId: string
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
