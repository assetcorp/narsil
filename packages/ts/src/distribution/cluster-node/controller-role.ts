import { DEFAULT_CONTROLLER_CONFIG } from '../cluster/constants'
import { createController } from '../cluster/controller'
import type { ControllerMessageHandler, ControllerNode } from '../cluster/controller/types'
import type { NodeTransport } from '../transport/types'
import type { ClusterNodeConfig } from './types'

export interface NodeControllerErrors {
  onError: (indexName: string, error: unknown) => void
  onElectionError: (error: unknown) => void
  extraMessages?: ControllerMessageHandler
}

export interface ControllerTenure {
  standEarly(): Promise<void>
  start(): Promise<void>
  withdrawOnFailure(join: Promise<void>): Promise<void>
}

export function createControllerTenure(
  controller: () => ControllerNode | null,
  startControllerJobs: () => void,
  onError: (error: unknown) => void,
): ControllerTenure {
  let standing = false
  return {
    async standEarly() {
      const node = controller()
      if (node === null || standing) return
      standing = true
      try {
        await node.start()
      } catch (error) {
        onError(error)
      }
    },
    async start() {
      const node = controller()
      if (node === null) return
      if (!standing) await node.start()
      standing = true
      startControllerJobs()
    },
    async withdrawOnFailure(join) {
      try {
        await join
      } catch (error) {
        if (standing) {
          standing = false
          await controller()?.stop()
        }
        throw error
      }
    },
  }
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
    extraMessages: errors.extraMessages,
  })
}
