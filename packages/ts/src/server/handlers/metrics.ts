import type { ClusterMetrics } from '../../distribution/cluster-node/types/observability'
import { ErrorCodes, NarsilError } from '../../errors'
import { PROMETHEUS_TEXT_CONTENT_TYPE } from '../constants'
import type { HandlerDeps } from '../deps'
import { respondError } from '../handler-utils'
import type { RouteContext } from '../request'
import { sendText } from '../response'

function labelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')
}

function labels(pairs: Array<[string, string]>): string {
  return `{${pairs.map(([name, value]) => `${name}="${labelValue(value)}"`).join(',')}}`
}

function family(name: string, type: 'gauge' | 'histogram', help: string, samples: string[]): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples]
}

export function prometheusText(metrics: ClusterMetrics): string {
  const lines = [
    ...family(
      'narsil_replication_lag',
      'gauge',
      "Entries that the replica has yet to acknowledge, as the primary's last sequence number minus the replica's.",
      metrics.replicationLag.map(
        figure =>
          `narsil_replication_lag${labels([
            ['index', figure.indexName],
            ['partition', String(figure.partitionId)],
            ['replica', figure.replica],
          ])} ${figure.lag}`,
      ),
    ),
    ...family(
      'narsil_commit_point',
      'gauge',
      'The highest sequence number that the leader of the partition has acknowledged to a client.',
      metrics.commitPoints.map(
        figure =>
          `narsil_commit_point${labels([
            ['index', figure.indexName],
            ['partition', String(figure.partitionId)],
          ])} ${figure.commitPoint}`,
      ),
    ),
    ...family(
      'narsil_commit_point_floor',
      'gauge',
      'The floor on the commit point that the allocation table stores, raised when the controller admits a replica.',
      metrics.partitions.map(
        figure =>
          `narsil_commit_point_floor${labels([
            ['index', figure.indexName],
            ['partition', String(figure.partitionId)],
          ])} ${figure.commitPointFloor}`,
      ),
    ),
    ...family(
      'narsil_in_sync_replicas',
      'gauge',
      'The replicas besides the primary that are in the in-sync set of the partition.',
      metrics.partitions.map(
        figure =>
          `narsil_in_sync_replicas${labels([
            ['index', figure.indexName],
            ['partition', String(figure.partitionId)],
          ])} ${figure.inSyncReplicas}`,
      ),
    ),
    ...family(
      'narsil_vector_rebuild_waiting_for_memory',
      'gauge',
      'A vector field whose rebuild waits for the node to have memory for a second graph, reported as 1.',
      metrics.vectorRebuildsWaitingForMemory.map(
        figure =>
          `narsil_vector_rebuild_waiting_for_memory${labels([
            ['index', figure.indexName],
            ['field', figure.fieldName],
          ])} 1`,
      ),
    ),
    ...family(
      'narsil_coordinator_request_seconds',
      'histogram',
      'How long the calls from this node to the cluster coordinator took.',
      metrics.coordinatorRequests.flatMap(figure => {
        const operation: [string, string] = ['operation', figure.operation]
        return [
          ...figure.bucketBoundsSeconds.map(
            (bound, position) =>
              `narsil_coordinator_request_seconds_bucket${labels([operation, ['le', String(bound)]])} ${figure.bucketCounts[position] ?? 0}`,
          ),
          `narsil_coordinator_request_seconds_bucket${labels([operation, ['le', '+Inf']])} ${figure.count}`,
          `narsil_coordinator_request_seconds_sum${labels([operation])} ${figure.sumSeconds}`,
          `narsil_coordinator_request_seconds_count${labels([operation])} ${figure.count}`,
        ]
      }),
    ),
  ]
  return `${lines.join('\n')}\n`
}

export function createMetricsHandler(deps: HandlerDeps) {
  return async function metrics(ctx: RouteContext): Promise<void> {
    try {
      if (deps.cluster === undefined) {
        throw new NarsilError(
          ErrorCodes.CLUSTER_OPERATION_UNSUPPORTED,
          'This server fronts a single engine, so it reports no cluster metrics',
          {},
        )
      }
      const text = prometheusText(await deps.cluster.getMetrics())
      if (ctx.abort.aborted) return
      sendText(ctx.res, text, PROMETHEUS_TEXT_CONTENT_TYPE, ctx.abort)
    } catch (err) {
      respondError(ctx, err)
    }
  }
}
