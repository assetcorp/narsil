import { validateIndexName } from '../../distribution/cluster/index-metadata'
import type { ClusterNamespace } from '../../distribution/cluster-node/types'
import { ErrorCodes, NarsilError } from '../../errors'
import type { HandlerDeps } from '../deps'
import { badRequest, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'

interface PartitionReport {
  partitionId: number
  state: string
  primary: string | null
  primaryTerm: number
  commitPoint: number
  replicas: string[]
  inSyncSet: string[]
  lastHolders: string[]
  unassignedReason: string | null
}

function requireCluster(deps: HandlerDeps): ClusterNamespace {
  if (deps.cluster === undefined) {
    throw new NarsilError(
      ErrorCodes.CLUSTER_OPERATION_UNSUPPORTED,
      'This server fronts a single engine, so it reports no cluster',
      {},
    )
  }
  return deps.cluster
}

/**
 * Describes the node a server fronts, as `/readyz` and `/cluster` both report it.
 *
 * @param cluster - The cluster-facing side of the node.
 * @returns The node's id, roles, lifecycle status, readiness, and whether it holds the controller lease.
 */
export function describeNode(cluster: ClusterNamespace): Record<string, unknown> {
  return { ...cluster.getNodeInfo(), readiness: cluster.getReadiness(), isController: cluster.isControllerActive() }
}

function malformedIndexName(indexName: string): string | null {
  try {
    validateIndexName(indexName)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Reports what this node knows about its cluster, so that a dashboard reads the
 * topology from the node it talks to.
 *
 * `/cluster` names every registered node, the node holding the controller
 * lease, and this node's own readiness, while `/indexes/:name/cluster` reports
 * the allocation of one index partition by partition. A server fronting a
 * single engine answers both with `CLUSTER_OPERATION_UNSUPPORTED`, which
 * reaches the caller as status 501.
 *
 * @param deps - The handler dependencies, whose `cluster` field carries the node's cluster-facing side.
 * @returns The `topology` and `allocation` route handlers.
 */
export function createClusterHandlers(deps: HandlerDeps) {
  async function topology(ctx: RouteContext): Promise<void> {
    try {
      const cluster = requireCluster(deps)
      const [nodes, controllerNodeId] = await Promise.all([cluster.listNodes(), cluster.getControllerNodeId()])
      respondJson(ctx, {
        node: describeNode(cluster),
        controllerNodeId,
        nodes: nodes.map(node => ({ nodeId: node.nodeId, address: node.address, roles: [...node.roles] })),
      })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function allocation(ctx: RouteContext): Promise<void> {
    try {
      const cluster = requireCluster(deps)
      const indexName = ctx.params[0] ?? ''
      const malformed = malformedIndexName(indexName)
      if (malformed !== null) {
        badRequest(ctx.res, malformed, { indexName })
        return
      }

      const table = await cluster.getAllocation(indexName)
      if (table === null) {
        respondJson(ctx, { indexName, allocated: false, version: null, partitions: [] })
        return
      }

      const partitions: PartitionReport[] = []
      for (const [partitionId, assignment] of table.assignments) {
        partitions.push({
          partitionId,
          state: assignment.state,
          primary: assignment.primary,
          primaryTerm: assignment.primaryTerm,
          commitPoint: assignment.commitPoint,
          replicas: [...assignment.replicas],
          inSyncSet: [...assignment.inSyncSet],
          lastHolders: [...(assignment.lastHolders ?? [])],
          unassignedReason: assignment.unassignedReason ?? null,
        })
      }
      partitions.sort((left, right) => left.partitionId - right.partitionId)

      respondJson(ctx, { indexName, allocated: partitions.length > 0, version: table.version, partitions })
    } catch (err) {
      respondError(ctx, err)
    }
  }

  return { topology, allocation }
}
