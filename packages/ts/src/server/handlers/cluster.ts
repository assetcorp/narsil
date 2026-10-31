import { validateIndexName } from '../../distribution/cluster/index-metadata'
import type { ClusterNamespace } from '../../distribution/cluster-node/types'
import { isRecord } from '../../distribution/payload-guards'
import { ErrorCodes, NarsilError } from '../../errors'
import type { HandlerDeps } from '../deps'
import { badRequest, parseJson, respondError, respondJson } from '../handler-utils'
import type { RouteContext } from '../request'
import type {
  ClusterAllocationResponse,
  ClusterNodeReport,
  ClusterTopologyResponse,
  PartitionAllocationReport,
  ReplicationFactorResponse,
} from '../types'

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
export function describeNode(cluster: ClusterNamespace): ClusterNodeReport {
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
 * the allocation of one index partition by partition, and
 * `PUT /indexes/:name/replication-factor` changes how many replicas each
 * partition keeps, and `/cluster/health` reports a green, yellow, or red status
 * for the cluster and each index with status 200 whatever the status. A server
 * fronting a single engine answers all four with
 * `CLUSTER_OPERATION_UNSUPPORTED`, which reaches the caller as status 501.
 *
 * @param deps - The handler dependencies, whose `cluster` field carries the node's cluster-facing side.
 * @returns The `topology`, `allocation`, `replicationFactor`, and `health` route handlers.
 */
export function createClusterHandlers(deps: HandlerDeps) {
  async function topology(ctx: RouteContext): Promise<void> {
    try {
      const cluster = requireCluster(deps)
      const [nodes, controllerNodeId] = await Promise.all([cluster.listNodes(), cluster.getControllerNodeId()])
      respondJson(ctx, {
        node: describeNode(cluster),
        controllerNodeId,
        nodes: nodes.map(node => ({
          nodeId: node.nodeId,
          address: node.address,
          roles: [...node.roles],
          memory: node.memory ?? null,
        })),
      } satisfies ClusterTopologyResponse)
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
        respondJson(ctx, {
          indexName,
          allocated: false,
          version: null,
          partitions: [],
        } satisfies ClusterAllocationResponse)
        return
      }

      const partitions: PartitionAllocationReport[] = []
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

      respondJson(ctx, {
        indexName,
        allocated: partitions.length > 0,
        version: table.version,
        partitions,
      } satisfies ClusterAllocationResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function replicationFactor(ctx: RouteContext): Promise<void> {
    try {
      const cluster = requireCluster(deps)
      const indexName = ctx.params[0] ?? ''
      const malformed = malformedIndexName(indexName)
      if (malformed !== null) {
        badRequest(ctx.res, malformed, { indexName })
        return
      }
      const body = parseJson<unknown>(ctx)
      if (body === undefined) return
      const factor = isRecord(body) ? body.replicationFactor : undefined
      if (typeof factor !== 'number') {
        badRequest(ctx.res, 'The body must carry a numeric replicationFactor', { indexName })
        return
      }
      await cluster.setReplicationFactor(indexName, factor)
      respondJson(ctx, { indexName, replicationFactor: factor } satisfies ReplicationFactorResponse)
    } catch (err) {
      respondError(ctx, err)
    }
  }

  async function health(ctx: RouteContext): Promise<void> {
    try {
      respondJson(ctx, await requireCluster(deps).getHealth())
    } catch (err) {
      respondError(ctx, err)
    }
  }

  return { topology, allocation, replicationFactor, health }
}
