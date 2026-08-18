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
}

export const CONTROLLER_LEASE_KEY = '_narsil/controller'

export const DEFAULT_CONTROLLER_CONFIG = {
  leaseTtlMs: 15_000,
  standbyRetryMs: 5_000,
} as const

export interface ControllerNode {
  readonly isActive: boolean
  start(): Promise<void>
  stop(): Promise<void>
  shutdown(): Promise<void>
}
