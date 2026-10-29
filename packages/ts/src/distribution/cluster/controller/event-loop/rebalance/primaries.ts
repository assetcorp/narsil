import { ErrorCodes, NarsilError } from '../../../../../errors'
import type { AllocationTable, ClusterCoordinator } from '../../../../coordinator/types'
import { isValidInteger } from '../../../../payload-guards'
import type { ReshardCutoverPayload, ReshardStartPayload } from '../../../../transport/reshard-payloads'
import { ClusterMessageTypes } from '../../../../transport/types'
import type { RebalanceRecord } from '../../../rebalance/records'
import { exchangeRebalanceMessage } from '../../../rebalance/reply'
import type { EventLoopState } from '../state'

export interface RebalanceContext {
  state: EventLoopState
  coordinator: ClusterCoordinator
  nodeId: string
  isLive: () => boolean
  onError?: (indexName: string, error: unknown) => void
}

async function targetsOf(ctx: RebalanceContext, nodeId: string): Promise<string[]> {
  const nodes = await ctx.coordinator.listNodes()
  const address = nodes.find(node => node.nodeId === nodeId)?.address
  return address !== undefined && address.length > 0 && address !== nodeId ? [nodeId, address] : [nodeId]
}

async function sendToPrimary(
  ctx: RebalanceContext,
  primary: string,
  type: string,
  payload: ReshardStartPayload | ReshardCutoverPayload,
): Promise<Record<string, unknown>> {
  const transport = ctx.state.transport
  if (transport === null) {
    throw new NarsilError(ErrorCodes.NODE_NOT_CONTROLLER, `Node '${ctx.nodeId}' stopped leading the cluster`, {
      nodeId: ctx.nodeId,
    })
  }
  return exchangeRebalanceMessage({
    transport,
    senderId: ctx.nodeId,
    targets: await targetsOf(ctx, primary),
    type,
    payload,
    failureMessage: `Node '${primary}' did not answer ${type} for partition ${payload.partitionId} of index '${payload.indexName}'`,
    details: { indexName: payload.indexName, partitionId: payload.partitionId, primaryNodeId: primary },
  })
}

export async function sendReshardStart(
  ctx: RebalanceContext,
  indexName: string,
  record: RebalanceRecord,
  source: AllocationTable,
  partitionId: number,
  primary: string,
): Promise<void> {
  await sendToPrimary(ctx, primary, ClusterMessageTypes.RESHARD_START, {
    indexName,
    jobId: record.jobId,
    sourceGeneration: record.sourceGeneration,
    targetGeneration: record.targetGeneration,
    partitionId,
    sourcePartitionCount: source.assignments.size,
    targetPartitionCount: record.targetPartitionCount,
  })
}

export type StartedCopies = Map<number, { primaryTerm: number; sentAt: number }>

export async function ensureCopyStarted(
  ctx: RebalanceContext,
  indexName: string,
  record: RebalanceRecord,
  source: AllocationTable,
  partitionId: number,
  started: StartedCopies,
  resendAfterMs: number,
): Promise<void> {
  const assignment = source.assignments.get(partitionId)
  const primary = assignment?.primary ?? null
  if (assignment === undefined || primary === null) return
  const sent = started.get(partitionId)
  if (sent?.primaryTerm === assignment.primaryTerm && Date.now() - sent.sentAt < resendAfterMs) return
  await sendReshardStart(ctx, indexName, record, source, partitionId, primary)
  started.set(partitionId, { primaryTerm: assignment.primaryTerm, sentAt: Date.now() })
}

export async function sendReshardCutover(
  ctx: RebalanceContext,
  indexName: string,
  record: RebalanceRecord,
  partitionId: number,
  primary: string,
  action: ReshardCutoverPayload['action'],
): Promise<number> {
  const reply = await sendToPrimary(ctx, primary, ClusterMessageTypes.RESHARD_CUTOVER, {
    indexName,
    jobId: record.jobId,
    partitionId,
    action,
  })
  if (!isValidInteger(reply.lastSeqNo) || reply.lastSeqNo < 0) {
    throw new NarsilError(
      ErrorCodes.ALLOCATION_FAILED,
      `Node '${primary}' answered the cutover of partition ${partitionId} of index '${indexName}' without a sequence number`,
      { indexName, partitionId, primaryNodeId: primary },
    )
  }
  return reply.lastSeqNo
}

export async function liftEveryBlock(ctx: RebalanceContext, indexName: string, record: RebalanceRecord) {
  const source = await ctx.coordinator.getAllocation(record.sourceGeneration)
  if (source === null) return
  await Promise.all(
    [...source.assignments].map(async ([partitionId, assignment]) => {
      if (assignment.primary === null) return
      try {
        await sendReshardCutover(ctx, indexName, record, partitionId, assignment.primary, 'lift')
      } catch (_) {}
    }),
  )
}
