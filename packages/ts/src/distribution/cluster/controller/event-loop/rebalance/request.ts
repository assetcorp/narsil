import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../../../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../../../../errors'
import { MAX_PARTITION_COUNT } from '../../../../constants'
import type { ClusterCoordinator } from '../../../../coordinator/types'
import { isRecord, isValidInteger } from '../../../../payload-guards'
import type { RebalancePayload, RebalanceResultPayload } from '../../../../transport/reshard-payloads'
import type { RespondFn, TransportMessage } from '../../../../transport/types'
import { ClusterMessageTypes } from '../../../../transport/types'
import { getIndexMetadata } from '../../../index-metadata'
import {
  createRebalanceRecord,
  generationNameOf,
  isHiddenGeneration,
  type RebalanceRecord,
  readRebalanceRecord,
} from '../../../rebalance/records'
import { encodeRebalanceRefusal } from '../../../rebalance/reply'
import type { EventLoopState } from '../state'
import { startRebalanceDriver } from './driver'

export interface RebalanceRequestContext {
  state: EventLoopState
  coordinator: ClusterCoordinator
  nodeId: string
  isActive: () => boolean
  onError?: (indexName: string, error: unknown) => void
}

function readPayload(message: TransportMessage): RebalancePayload {
  let decoded: unknown
  try {
    decoded = decode(message.payload)
  } catch (_) {
    decoded = null
  }
  if (!isRecord(decoded) || typeof decoded.indexName !== 'string' || decoded.indexName.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A partition count change must name an index', {})
  }
  const { indexName, targetPartitionCount } = decoded
  if (!isValidInteger(targetPartitionCount) || targetPartitionCount < 1 || targetPartitionCount > MAX_PARTITION_COUNT) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `The partition count of index '${indexName}' must be an integer from 1 to ${MAX_PARTITION_COUNT}`,
      { indexName, targetPartitionCount: String(targetPartitionCount) },
    )
  }
  if (isHiddenGeneration(indexName)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `Index '${indexName}' is a hidden partition layout`, {
      indexName,
    })
  }
  return { indexName, targetPartitionCount }
}

async function recordRebalance(ctx: RebalanceRequestContext, message: TransportMessage) {
  if (!ctx.isActive()) {
    throw new NarsilError(ErrorCodes.NODE_NOT_CONTROLLER, `Node '${ctx.nodeId}' does not hold the controller lease`, {
      nodeId: ctx.nodeId,
    })
  }
  const { indexName, targetPartitionCount } = readPayload(message)
  const notFound = new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' has no metadata in the cluster`, {
    indexName,
  })
  if ((await getIndexMetadata(ctx.coordinator, indexName)) === null) throw notFound
  const sourceGeneration = (await ctx.coordinator.getAllocation(indexName))?.generation ?? indexName
  const source = await getIndexMetadata(ctx.coordinator, sourceGeneration)
  if (source === null) throw notFound
  if (source.partitionCount === targetPartitionCount) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `Index '${indexName}' already has ${targetPartitionCount} partitions`,
      { indexName, targetPartitionCount },
    )
  }

  const record: RebalanceRecord = {
    jobId: generateId(),
    sourceGeneration,
    targetGeneration: generationNameOf(generateId()),
    targetPartitionCount,
    phase: 'copying',
    cutoverAttempts: 0,
  }
  if (!(await createRebalanceRecord(ctx.coordinator, indexName, record))) {
    const running = await readRebalanceRecord(ctx.coordinator, indexName)
    if (running !== null) startRebalanceDriver(ctx, indexName, running.jobId)
    throw new NarsilError(
      ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
      `Index '${indexName}' is already changing its partition count`,
      { indexName, jobId: running?.jobId ?? null },
    )
  }
  startRebalanceDriver(ctx, indexName, record.jobId)
  const result: RebalanceResultPayload = {
    indexName,
    jobId: record.jobId,
    targetGeneration: record.targetGeneration,
  }
  return result
}

export function handleRebalanceMessage(
  ctx: RebalanceRequestContext,
  message: TransportMessage,
  respond: RespondFn,
): void {
  recordRebalance(ctx, message).then(
    result =>
      respond({
        type: ClusterMessageTypes.REBALANCE,
        sourceId: ctx.nodeId,
        requestId: message.requestId,
        payload: encode(result),
      }).catch(() => {}),
    error =>
      respond({
        type: `${ClusterMessageTypes.REBALANCE}.error`,
        sourceId: ctx.nodeId,
        requestId: message.requestId,
        payload: encodeRebalanceRefusal(error),
      }).catch(() => {}),
  )
}

export async function resumeRebalance(ctx: RebalanceRequestContext, indexName: string): Promise<void> {
  if (isHiddenGeneration(indexName) || !ctx.isActive()) return
  try {
    const record = await readRebalanceRecord(ctx.coordinator, indexName)
    if (record !== null) startRebalanceDriver(ctx, indexName, record.jobId)
  } catch (error) {
    ctx.onError?.(indexName, error)
  }
}

export async function resumeRebalances(ctx: RebalanceRequestContext): Promise<void> {
  for (const indexName of await ctx.coordinator.listSchemas()) {
    await resumeRebalance(ctx, indexName)
  }
}
