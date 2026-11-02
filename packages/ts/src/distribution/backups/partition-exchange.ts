import { ErrorCodes, NarsilError } from '../../errors'
import { pause } from '../cluster/rebalance/pause'
import { exchangeRebalanceMessage } from '../cluster/rebalance/reply'
import { resolveNodeTargets } from '../cluster-node/node-messaging'
import type { PartitionAssignment } from '../coordinator/types'
import type { PartitionTaskPayload } from '../transport/backup-payloads'
import { BACKUP_PARTITION_POLL_INTERVAL_MS, BACKUP_PRIMARY_WAIT_MS } from './constants'
import { assertStillDriving, type BackupDriverContext } from './driver-context'

const RETRIED_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
  ErrorCodes.PARTITION_NOT_PRIMARY,
  ErrorCodes.NODE_NOT_READY,
  ErrorCodes.NODE_NOT_JOINED,
])

export interface PartitionTask<T> {
  type: string
  payload: PartitionTaskPayload
  readResult: (value: unknown) => T
}

export interface PartitionTaskOutcome<T> {
  result: T
  primary: string
  primaryTerm: number
}

function noPrimary(payload: PartitionTaskPayload): NarsilError {
  return new NarsilError(
    ErrorCodes.QUERY_NO_ACTIVE_REPLICA,
    `Partition ${payload.partitionId} of index '${payload.indexName}' had no active primary for ${BACKUP_PRIMARY_WAIT_MS} ms`,
    { indexName: payload.indexName, partitionId: payload.partitionId },
  )
}

function isRetried(error: unknown): boolean {
  return error instanceof NarsilError && RETRIED_CODES.has(error.code)
}

async function activePrimaryOf(context: BackupDriverContext, payload: PartitionTaskPayload) {
  const table = await context.config.coordinator.getAllocation(payload.indexName)
  const assignment: PartitionAssignment | undefined = table?.assignments.get(payload.partitionId)
  if (assignment === undefined || assignment.primary === null || assignment.state !== 'ACTIVE') return null
  return { primary: assignment.primary, primaryTerm: assignment.primaryTerm }
}

function unreadable(primary: string, payload: PartitionTaskPayload): NarsilError {
  return new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `Node '${primary}' sent an unreadable answer for partition ${payload.partitionId} of index '${payload.indexName}'`,
    { indexName: payload.indexName, partitionId: payload.partitionId, nodeId: primary },
  )
}

function failureOf(reply: Record<string, unknown>, primary: string, payload: PartitionTaskPayload): NarsilError {
  const error = reply.error
  if (typeof error !== 'object' || error === null) return unreadable(primary, payload)
  const { code, message } = error as { code?: unknown; message?: unknown }
  return new NarsilError(
    typeof code === 'string' ? code : ErrorCodes.ALLOCATION_FAILED,
    typeof message === 'string' ? message : `Partition ${payload.partitionId} failed`,
    { indexName: payload.indexName, partitionId: payload.partitionId, nodeId: primary },
  )
}

export async function forEachPartition(
  partitionCount: number,
  atOnce: number,
  task: (partitionId: number) => Promise<void>,
): Promise<void> {
  let next = 0
  let failed = false
  async function worker(): Promise<void> {
    while (!failed && next < partitionCount) {
      const partitionId = next++
      try {
        await task(partitionId)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(atOnce, partitionCount) }, worker))
}

export async function drivePartitionTask<T>(
  context: BackupDriverContext,
  task: PartitionTask<T>,
): Promise<PartitionTaskOutcome<T>> {
  const { payload } = task
  let deadline = Date.now() + BACKUP_PRIMARY_WAIT_MS
  for (;;) {
    assertStillDriving(context)
    const target = await activePrimaryOf(context, payload)
    if (target === null) {
      if (Date.now() > deadline) throw noPrimary(payload)
      await pause(BACKUP_PARTITION_POLL_INTERVAL_MS)
      continue
    }
    try {
      const reply = await exchangeRebalanceMessage({
        transport: context.config.transport,
        senderId: context.nodeId,
        targets: await resolveNodeTargets(context.config, target.primary),
        type: task.type,
        payload,
        failureMessage: `Node '${target.primary}' did not answer for partition ${payload.partitionId} of index '${payload.indexName}'`,
        details: { indexName: payload.indexName, partitionId: payload.partitionId, targetNodeId: target.primary },
      })
      if (reply.jobId !== payload.jobId || reply.partitionId !== payload.partitionId) {
        throw unreadable(target.primary, payload)
      }
      if (reply.status === 'done') return { result: task.readResult(reply.result), ...target }
      if (reply.status === 'failed') throw failureOf(reply, target.primary, payload)
      if (reply.status !== 'running') throw unreadable(target.primary, payload)
      deadline = Date.now() + BACKUP_PRIMARY_WAIT_MS
    } catch (error) {
      if (!isRetried(error) || Date.now() > deadline) throw error
    }
    await pause(BACKUP_PARTITION_POLL_INTERVAL_MS)
  }
}
