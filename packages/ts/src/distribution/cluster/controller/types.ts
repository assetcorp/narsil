import type { ClusterCoordinator } from '../../coordinator/types'
import type { NodeTransport } from '../../transport/types'

export interface ControllerConfig {
  nodeId: string
  coordinator: ClusterCoordinator
  transport: NodeTransport
  leaseTtlMs: number
  standbyRetryMs: number
  knownIndexNames: string[]
  onError?: (indexName: string, error: unknown) => void
  onElectionError?: (error: unknown) => void
}

export const CONTROLLER_LEASE_KEY = '_narsil/controller'

export interface ControllerNode {
  readonly isActive: boolean
  start(): Promise<void>
  stop(): Promise<void>
  shutdown(): Promise<void>
}
