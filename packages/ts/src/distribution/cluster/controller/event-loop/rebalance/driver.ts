import { ErrorCodes, NarsilError } from '../../../../../errors'
import type { AllocationTable } from '../../../../coordinator/types'
import {
  MAX_RESHARD_CUTOVER_ATTEMPTS,
  RESHARD_CONTROLLER_POLL_INTERVAL_MS,
  RESHARD_CUTOVER_LAG_ENTRIES,
  RESHARD_RECORD_CHECK_INTERVAL_MS,
} from '../../../constants'
import { getIndexMetadata } from '../../../index-metadata'
import { lastHoldersOf } from '../../../last-holders'
import {
  clearEveryProgress,
  dropGeneration,
  dropReplacedNameSynonymSet,
  ensureGeneration,
} from '../../../rebalance/generation'
import { pause } from '../../../rebalance/pause'
import {
  type RebalanceRecord,
  readRebalanceProgress,
  readRebalanceRecord,
  updateRebalanceRecord,
} from '../../../rebalance/records'
import { attemptCutover } from './cutover'
import { ensureCopyStarted, liftEveryBlock, type RebalanceContext, type StartedCopies } from './primaries'

type DriverStep = 'finished' | 'continue'

const ABORTING_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.INDEX_NOT_FOUND,
  ErrorCodes.CONTROLLER_METADATA_INVALID,
  ErrorCodes.CONFIG_INVALID,
])

function servesEveryPartition(table: AllocationTable | null, partitionCount: number): boolean {
  if (table === null || table.assignments.size !== partitionCount) return false
  for (const assignment of table.assignments.values()) {
    const { primary, inSyncSet } = assignment
    if (assignment.state !== 'ACTIVE' || primary === null) return false
    if (!assignment.replicas.every(nodeId => nodeId === primary || inSyncSet.includes(nodeId))) return false
  }
  return true
}

function lostAPartition(table: AllocationTable | null): boolean {
  if (table === null) return false
  for (const assignment of table.assignments.values()) {
    if (assignment.state === 'UNASSIGNED' && assignment.primary === null && lastHoldersOf(assignment).length > 0) {
      return true
    }
  }
  return false
}

async function startCopies(
  ctx: RebalanceContext,
  indexName: string,
  record: RebalanceRecord,
  source: AllocationTable,
  started: StartedCopies,
): Promise<void> {
  await Promise.all(
    [...source.assignments.keys()].map(async partitionId => {
      try {
        await ensureCopyStarted(ctx, indexName, record, source, partitionId, started, RESHARD_RECORD_CHECK_INTERVAL_MS)
      } catch (error) {
        ctx.onError?.(indexName, error)
      }
    }),
  )
}

async function copiesCaughtUp(
  ctx: RebalanceContext,
  indexName: string,
  record: RebalanceRecord,
  source: AllocationTable,
): Promise<boolean> {
  for (const [partitionId, assignment] of source.assignments) {
    const progress = await readRebalanceProgress(ctx.coordinator, indexName, partitionId)
    if (
      progress === null ||
      progress.jobId !== record.jobId ||
      progress.primaryTerm !== assignment.primaryTerm ||
      progress.sourceLastSeqNo - progress.forwardedSeqNo > RESHARD_CUTOVER_LAG_ENTRIES
    ) {
      return false
    }
  }
  return true
}

async function finishSwap(ctx: RebalanceContext, indexName: string, record: RebalanceRecord): Promise<void> {
  if (record.sourceGeneration === indexName) {
    const metadata = await getIndexMetadata(ctx.coordinator, indexName)
    await clearEveryProgress(ctx.coordinator, indexName, metadata?.partitionCount ?? 0)
    await dropReplacedNameSynonymSet(ctx.coordinator, indexName)
  } else {
    const source = await ctx.coordinator.getAllocation(record.sourceGeneration)
    await clearEveryProgress(ctx.coordinator, indexName, source?.assignments.size ?? 0)
    await dropGeneration(ctx.coordinator, ctx.nodeId, record.sourceGeneration)
  }
  await updateRebalanceRecord(ctx.coordinator, indexName, record.jobId, () => null)
}

async function finishAbort(ctx: RebalanceContext, indexName: string, record: RebalanceRecord): Promise<void> {
  await dropGeneration(ctx.coordinator, ctx.nodeId, record.targetGeneration)
  const source = await ctx.coordinator.getAllocation(record.sourceGeneration)
  await clearEveryProgress(ctx.coordinator, indexName, source?.assignments.size ?? 0)
  await updateRebalanceRecord(ctx.coordinator, indexName, record.jobId, () => null)
  await liftEveryBlock(ctx, indexName, record)
}

function markAborting(ctx: RebalanceContext, indexName: string, jobId: string) {
  return updateRebalanceRecord(ctx.coordinator, indexName, jobId, current => ({ ...current, phase: 'aborting' }))
}

async function advance(
  ctx: RebalanceContext,
  indexName: string,
  record: RebalanceRecord,
  started: StartedCopies,
): Promise<DriverStep> {
  const nameTable = await ctx.coordinator.getAllocation(indexName)
  if (nameTable?.generation === record.targetGeneration) {
    await finishSwap(ctx, indexName, record)
    return 'finished'
  }
  if (record.phase === 'aborting') {
    await finishAbort(ctx, indexName, record)
    return 'finished'
  }
  if (record.phase === 'cutover') {
    await liftEveryBlock(ctx, indexName, record)
    await updateRebalanceRecord(ctx.coordinator, indexName, record.jobId, current =>
      current.phase === 'cutover' ? { ...current, phase: 'copying' } : current,
    )
    return 'continue'
  }
  if (record.cutoverAttempts >= MAX_RESHARD_CUTOVER_ATTEMPTS) {
    await markAborting(ctx, indexName, record.jobId)
    return 'continue'
  }

  await ensureGeneration(ctx.coordinator, record)
  const current = await readRebalanceRecord(ctx.coordinator, indexName)
  if (current === null || current.jobId !== record.jobId || current.phase === 'aborting') {
    await dropGeneration(ctx.coordinator, ctx.nodeId, record.targetGeneration)
    return current?.jobId === record.jobId ? 'continue' : 'finished'
  }
  const target = await ctx.coordinator.getAllocation(record.targetGeneration)
  if (lostAPartition(target)) {
    await markAborting(ctx, indexName, record.jobId)
    return 'continue'
  }
  if (!servesEveryPartition(target, record.targetPartitionCount)) return 'continue'
  const source =
    record.sourceGeneration === indexName ? nameTable : await ctx.coordinator.getAllocation(record.sourceGeneration)
  if (source === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${record.sourceGeneration}' has no allocation table`, {
      indexName: record.sourceGeneration,
    })
  }
  await startCopies(ctx, indexName, record, source, started)
  if (!(await copiesCaughtUp(ctx, indexName, record, source))) return 'continue'

  const outcome = await attemptCutover(ctx, indexName, record, started)
  if (outcome === 'swapped') {
    await finishSwap(ctx, indexName, record)
    return 'finished'
  }
  return outcome === 'gone' ? 'finished' : 'continue'
}

async function drive(ctx: RebalanceContext, indexName: string, jobId: string): Promise<void> {
  const started: StartedCopies = new Map()
  while (ctx.isLive()) {
    try {
      const record = await readRebalanceRecord(ctx.coordinator, indexName)
      if (record === null || record.jobId !== jobId) return
      if ((await advance(ctx, indexName, record, started)) === 'finished') return
    } catch (error) {
      if (error instanceof NarsilError && ABORTING_CODES.has(error.code) && ctx.isLive()) {
        await markAborting(ctx, indexName, jobId).catch(() => null)
      }
      ctx.onError?.(indexName, error)
    }
    await pause(RESHARD_CONTROLLER_POLL_INTERVAL_MS)
  }
}

export function startRebalanceDriver(
  ctx: Omit<RebalanceContext, 'isLive'> & { isActive: () => boolean },
  indexName: string,
  jobId: string,
): void {
  const { state } = ctx
  if (state.rebalanceDrivers.get(indexName) === jobId) return
  state.rebalanceDrivers.set(indexName, jobId)
  const epoch = state.rebalanceEpoch
  const isLive = () => ctx.isActive() && state.rebalanceEpoch === epoch
  drive({ ...ctx, isLive }, indexName, jobId)
    .catch(error => ctx.onError?.(indexName, error))
    .finally(() => {
      if (state.rebalanceEpoch === epoch && state.rebalanceDrivers.get(indexName) === jobId) {
        state.rebalanceDrivers.delete(indexName)
      }
    })
}
