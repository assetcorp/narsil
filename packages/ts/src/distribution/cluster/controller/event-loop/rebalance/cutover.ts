import { ErrorCodes, NarsilError } from '../../../../../errors'
import type { AllocationTable, PartitionAssignment } from '../../../../coordinator/types'
import { RESHARD_CONTROLLER_POLL_INTERVAL_MS, RESHARD_CUTOVER_TIMEOUT_MS } from '../../../constants'
import { pause } from '../../../rebalance/pause'
import {
  type RebalanceRecord,
  readRebalanceProgress,
  readRebalanceRecord,
  updateRebalanceRecord,
} from '../../../rebalance/records'
import {
  ensureCopyStarted,
  liftEveryBlock,
  type RebalanceContext,
  type StartedCopies,
  sendReshardCutover,
} from './primaries'

interface BlockedPartition {
  primary: string
  primaryTerm: number
  lastSeqNo: number
}

export type CutoverOutcome = 'swapped' | 'retry' | 'gone'

async function blockedAndForwarded(
  ctx: RebalanceContext,
  indexName: string,
  record: RebalanceRecord,
  source: AllocationTable,
  partitionId: number,
  assignment: PartitionAssignment,
  blocked: Map<number, BlockedPartition>,
  started: StartedCopies,
): Promise<boolean> {
  const primary = assignment.primary
  if (primary === null) return false
  try {
    const held = blocked.get(partitionId)
    if (held === undefined || held.primary !== primary || held.primaryTerm !== assignment.primaryTerm) {
      await ensureCopyStarted(ctx, indexName, record, source, partitionId, started, Number.POSITIVE_INFINITY)
      const lastSeqNo = await sendReshardCutover(ctx, indexName, record, partitionId, primary, 'block')
      blocked.set(partitionId, { primary, primaryTerm: assignment.primaryTerm, lastSeqNo })
    }
    const current = blocked.get(partitionId)
    const progress = await readRebalanceProgress(ctx.coordinator, indexName, partitionId)
    return (
      current !== undefined &&
      progress !== null &&
      progress.jobId === record.jobId &&
      progress.primaryTerm === current.primaryTerm &&
      progress.forwardedSeqNo >= current.lastSeqNo
    )
  } catch (error) {
    ctx.onError?.(indexName, error)
    return false
  }
}

async function everyPartitionCaughtUp(
  ctx: RebalanceContext,
  indexName: string,
  record: RebalanceRecord,
  blocked: Map<number, BlockedPartition>,
  started: StartedCopies,
): Promise<boolean> {
  const source = await ctx.coordinator.getAllocation(record.sourceGeneration)
  if (source === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${record.sourceGeneration}' was dropped during cutover`, {
      indexName: record.sourceGeneration,
    })
  }
  const answers = await Promise.all(
    [...source.assignments].map(([partitionId, assignment]) =>
      blockedAndForwarded(ctx, indexName, record, source, partitionId, assignment, blocked, started),
    ),
  )
  return answers.every(Boolean)
}

function blockStillHolds(source: AllocationTable, blocked: Map<number, BlockedPartition>): boolean {
  for (const [partitionId, assignment] of source.assignments) {
    const held = blocked.get(partitionId)
    if (held === undefined || held.primary !== assignment.primary || held.primaryTerm !== assignment.primaryTerm) {
      return false
    }
  }
  return true
}

async function swapIndexName(
  ctx: RebalanceContext,
  indexName: string,
  record: RebalanceRecord,
  blocked: Map<number, BlockedPartition>,
): Promise<boolean> {
  const nameTable = await ctx.coordinator.getAllocation(indexName)
  if (nameTable === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' was dropped during cutover`, { indexName })
  }
  if (nameTable.generation === record.targetGeneration) return true
  const source =
    record.sourceGeneration === indexName ? nameTable : await ctx.coordinator.getAllocation(record.sourceGeneration)
  if (source === null || !blockStillHolds(source, blocked)) return false
  const target = await ctx.coordinator.getAllocation(record.targetGeneration)
  const pointer: AllocationTable = {
    indexName,
    version: nameTable.version + 1,
    replicationFactor: target?.replicationFactor ?? nameTable.replicationFactor,
    assignments: new Map(),
    generation: record.targetGeneration,
  }
  return ctx.coordinator.putAllocation(indexName, pointer, nameTable.version, ctx.nodeId)
}

export async function attemptCutover(
  ctx: RebalanceContext,
  indexName: string,
  record: RebalanceRecord,
  started: StartedCopies,
): Promise<CutoverOutcome> {
  const cut = await updateRebalanceRecord(ctx.coordinator, indexName, record.jobId, current =>
    current.phase === 'copying'
      ? { ...current, phase: 'cutover', cutoverAttempts: current.cutoverAttempts + 1 }
      : current,
  )
  if (cut === null) return 'gone'
  if (cut.phase !== 'cutover') return 'retry'

  const blocked = new Map<number, BlockedPartition>()
  const deadline = Date.now() + RESHARD_CUTOVER_TIMEOUT_MS
  while (Date.now() < deadline && ctx.isLive()) {
    const latest = await readRebalanceRecord(ctx.coordinator, indexName)
    if (latest === null || latest.jobId !== cut.jobId) return 'gone'
    if (latest.phase === 'aborting') return 'retry'
    if (
      (await everyPartitionCaughtUp(ctx, indexName, cut, blocked, started)) &&
      (await swapIndexName(ctx, indexName, cut, blocked))
    ) {
      return 'swapped'
    }
    await pause(RESHARD_CONTROLLER_POLL_INTERVAL_MS)
  }
  if (!ctx.isLive()) return 'retry'

  await liftEveryBlock(ctx, indexName, cut)
  const lifted = await updateRebalanceRecord(ctx.coordinator, indexName, cut.jobId, current =>
    current.phase === 'cutover' ? { ...current, phase: 'copying' } : current,
  )
  return lifted === null ? 'gone' : 'retry'
}
