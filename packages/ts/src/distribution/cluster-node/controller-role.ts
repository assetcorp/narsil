import { DEFAULT_CONTROLLER_CONFIG } from '../cluster/constants'
import { createController } from '../cluster/controller'
import type { ControllerNode } from '../cluster/controller/types'
import type { NodeTransport } from '../transport/types'
import type { ClusterNodeConfig } from './types'

export interface NodeControllerErrors {
  onError: (indexName: string, error: unknown) => void
  onElectionError: (error: unknown) => void
}

export function createNodeController(
  config: ClusterNodeConfig,
  nodeId: string,
  transport: NodeTransport,
  errors: NodeControllerErrors,
): ControllerNode {
  return createController({
    nodeId,
    coordinator: config.coordinator,
    transport,
    leaseTtlMs: config.controller?.leaseTtlMs ?? DEFAULT_CONTROLLER_CONFIG.leaseTtlMs,
    standbyRetryMs: config.controller?.standbyRetryMs ?? DEFAULT_CONTROLLER_CONFIG.standbyRetryMs,
    nodeLeftDelayMs: config.controller?.nodeLeftDelayMs ?? DEFAULT_CONTROLLER_CONFIG.nodeLeftDelayMs,
    knownIndexNames: [],
    onError: errors.onError,
    onElectionError: errors.onElectionError,
  })
}
