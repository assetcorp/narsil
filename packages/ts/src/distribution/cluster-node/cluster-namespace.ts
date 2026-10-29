import type { ControllerNode } from '../cluster/controller/types'
import { CONTROLLER_LEASE_KEY } from '../cluster/controller/types'
import type { DataNodeHandle } from '../cluster/node-lifecycle/types'
import type { ClusterCoordinator, NodeRole } from '../coordinator/types'
import { readClusterHealth } from './observability/health'
import { type ClusterMetricsDeps, readClusterMetrics } from './observability/metrics'
import type { ClusterNamespace, NodeReadiness } from './types'

export interface ClusterNamespaceDeps {
  nodeId: string
  roles: ReadonlyArray<NodeRole>
  coordinator: ClusterCoordinator
  lifecycle: () => DataNodeHandle
  controller: () => ControllerNode | null
  isShutdown: () => boolean
  isServing: () => boolean
  trackOp: <T>(indexName: string | null, fn: () => Promise<T>) => Promise<T>
  requestReplicationFactor: (indexName: string, replicationFactor: number) => Promise<void>
  observability: ClusterMetricsDeps
}

function readinessOf(deps: ClusterNamespaceDeps): NodeReadiness {
  if (deps.isShutdown()) {
    return 'LEAVING'
  }

  const lifecycle = deps.lifecycle()
  if (lifecycle.status === 'leaving' || lifecycle.status === 'shutdown') {
    return 'LEAVING'
  }
  if (!lifecycle.registered) {
    return 'STARTING'
  }
  if (lifecycle.status !== 'active' || !deps.isServing() || lifecycle.pendingPartitionCount > 0) {
    return 'JOINING'
  }
  return 'SERVING'
}

/**
 * Builds the cluster-facing side of a node, which answers for the node itself and for the cluster around it.
 *
 * A readiness probe reads its answer here. A node that has yet to bring a partition the controller gave it into
 * service reports `JOINING`, and it reports `SERVING` once every one of them is in service.
 *
 * @param deps - The node's identity, its lifecycle and controller handles, and the coordinator it reads from.
 * @returns The namespace the node exposes as `cluster`.
 */
export function createClusterNamespace(deps: ClusterNamespaceDeps): ClusterNamespace {
  return {
    async getAllocation(indexName: string) {
      return deps.trackOp(null, async () => {
        const table = await deps.coordinator.getAllocation(indexName)
        if (table?.generation === undefined) return table
        const served = await deps.coordinator.getAllocation(table.generation)
        return served === null ? null : { ...served, indexName }
      })
    },
    getNodeInfo() {
      return { nodeId: deps.nodeId, roles: [...deps.roles], status: deps.lifecycle().status }
    },
    isControllerActive() {
      return deps.controller()?.isActive ?? false
    },
    getReadiness() {
      return readinessOf(deps)
    },
    async listNodes() {
      return deps.trackOp(null, () => deps.coordinator.listNodes())
    },
    async getControllerNodeId() {
      return deps.trackOp(null, () => deps.coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY))
    },
    async setReplicationFactor(indexName: string, replicationFactor: number) {
      return deps.trackOp(null, () => deps.requestReplicationFactor(indexName, replicationFactor))
    },
    async getHealth() {
      return deps.trackOp(null, () => readClusterHealth(deps.observability.coordinator))
    },
    async getMetrics() {
      return deps.trackOp(null, () => readClusterMetrics(deps.observability))
    },
  }
}
