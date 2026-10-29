import { ErrorCodes, NarsilError } from '../../../errors'
import {
  RESHARD_FORWARD_BATCH_DOCUMENTS,
  RESHARD_POLL_INTERVAL_MS,
  RESHARD_RECORD_CHECK_INTERVAL_MS,
  RESHARD_RETRY_DELAY_MS,
} from '../../cluster/constants'
import { pause } from '../../cluster/rebalance/pause'
import { isHiddenGeneration, readRebalanceRecord } from '../../cluster/rebalance/records'
import type {
  ReshardCutoverPayload,
  ReshardForwardOperation,
  ReshardStartPayload,
} from '../../transport/reshard-payloads'
import { enqueuePartitionWrite } from '../write-routing/partition-queue'
import { reconcileReshardBlock } from './block'
import {
  type CopyPosition,
  copySnapshot,
  type ReshardSourceDeps,
  recordProgress,
  resumePosition,
  retrying,
  stillLeading,
} from './copy'
import { forwardToGeneration } from './forward'
import { forwardableEnd, leadingAssignment } from './leadership'
import { jobKey, type ReshardCopyJob, type ReshardState, setReshardBlock } from './state'

type TailOutcome = 'truncated' | 'stopped'

function reshardState(deps: ReshardSourceDeps): ReshardState {
  const state = deps.writeDeps.reshard
  if (state === undefined) {
    throw new NarsilError(ErrorCodes.NODE_NOT_READY, `Node '${deps.writeDeps.nodeId}' cannot copy partitions`, {
      nodeId: deps.writeDeps.nodeId,
    })
  }
  return state
}

async function checkRecord(deps: ReshardSourceDeps, job: ReshardCopyJob): Promise<void> {
  const state = reshardState(deps)
  const coordinator = deps.writeDeps.coordinator
  await reconcileReshardBlock(state, coordinator, job.indexName, job.sourceGeneration, job.partitionId)
  const record = await readRebalanceRecord(coordinator, job.indexName)
  if (record === null || record.jobId !== job.jobId || !(await stillLeading(deps, job))) job.stopped = true
}

function operationsFrom(deps: ReshardSourceDeps, job: ReshardCopyJob, first: number, last: number) {
  const log = deps.writeDeps.getReplicationLog(job.sourceGeneration, job.partitionId)
  const operations: ReshardForwardOperation[] = []
  for (let seqNo = first; seqNo <= last; seqNo++) {
    const entry = log.getEntry(seqNo)
    if (entry === undefined) return null
    operations.push(
      entry.operation === 'INDEX' && entry.document !== null
        ? { documentId: entry.documentId, operation: 'replace', document: entry.document }
        : { documentId: entry.documentId, operation: 'remove' },
    )
  }
  return operations
}

async function tailLog(deps: ReshardSourceDeps, job: ReshardCopyJob, position: CopyPosition): Promise<TailOutcome> {
  let checkedAt = 0
  while (!job.stopped) {
    if (Date.now() - checkedAt >= RESHARD_RECORD_CHECK_INTERVAL_MS) {
      checkedAt = Date.now()
      await checkRecord(deps, job).catch(() => undefined)
      if (job.stopped) break
    }
    const end = forwardableEnd(deps.writeDeps.getReplicationLog(job.sourceGeneration, job.partitionId), job.primaryTerm)
    if (end > position.forwardedSeqNo) {
      const first = position.forwardedSeqNo + 1
      const last = Math.min(end, first + RESHARD_FORWARD_BATCH_DOCUMENTS - 1)
      const operations = operationsFrom(deps, job, first, last)
      if (operations === null) return 'truncated'
      if (!(await retrying(deps, job, () => forwardToGeneration(deps.writeDeps, job, operations)))) break
      position.forwardedSeqNo = last
      await recordProgress(deps, job, position, end)
      continue
    }
    if (position.reportedLastSeqNo !== end) await recordProgress(deps, job, position, end)
    await pause(RESHARD_POLL_INTERVAL_MS)
  }
  return 'stopped'
}

async function runCopy(
  deps: ReshardSourceDeps,
  job: ReshardCopyJob,
  announce: (snapshotSeqNo: number) => void,
): Promise<void> {
  let position = await resumePosition(deps, job)
  while (!job.stopped) {
    try {
      if (position === null) position = await copySnapshot(deps, job, announce)
      if (position === null) return
      announce(position.snapshotSeqNo)
      if ((await tailLog(deps, job, position)) === 'truncated') position = null
    } catch (error) {
      if (!(await stillLeading(deps, job).catch(() => true))) return
      deps.onError?.(error)
      await pause(RESHARD_RETRY_DELAY_MS)
    }
  }
}

export async function startReshardCopy(deps: ReshardSourceDeps, payload: ReshardStartPayload): Promise<number> {
  const state = reshardState(deps)
  const assignment = await leadingAssignment(deps.writeDeps, payload.sourceGeneration, payload.partitionId)
  const key = jobKey(payload.jobId, payload.partitionId)
  const existing = state.jobs.get(key)
  if (existing !== undefined && !existing.stopped && existing.primaryTerm === assignment.primaryTerm) {
    return existing.snapshotSeqNo
  }
  if (existing !== undefined) existing.stopped = true
  if (isHiddenGeneration(payload.sourceGeneration)) state.publicNames.set(payload.sourceGeneration, payload.indexName)

  let announce: (snapshotSeqNo: number) => void = () => undefined
  let refuse: (error: unknown) => void = () => undefined
  const snapshotSeqNo = new Promise<number>((resolve, reject) => {
    announce = resolve
    refuse = reject
  })
  const job: ReshardCopyJob = { ...payload, primaryTerm: assignment.primaryTerm, stopped: false, snapshotSeqNo }
  state.jobs.set(key, job)
  runCopy(deps, job, announce)
    .catch(error => {
      refuse(error)
      deps.onError?.(error)
    })
    .finally(() => {
      job.stopped = true
      refuse(
        new NarsilError(
          ErrorCodes.PARTITION_NOT_PRIMARY,
          `The copy of partition ${job.partitionId} of index '${job.indexName}' stopped before its snapshot`,
          { indexName: job.indexName, partitionId: job.partitionId },
        ),
      )
      if (state.jobs.get(key) === job) state.jobs.delete(key)
    })
  return snapshotSeqNo
}

export async function applyReshardCutover(deps: ReshardSourceDeps, payload: ReshardCutoverPayload): Promise<number> {
  const state = reshardState(deps)
  if (payload.action === 'lift') {
    for (const [key, block] of [...state.blocks]) {
      if (block.jobId === payload.jobId && block.partitionId === payload.partitionId) state.blocks.delete(key)
    }
    return 0
  }
  const record = await readRebalanceRecord(deps.writeDeps.coordinator, payload.indexName)
  if (record === null || record.jobId !== payload.jobId) {
    throw new NarsilError(
      ErrorCodes.ALLOCATION_FAILED,
      `Index '${payload.indexName}' runs no partition count change '${payload.jobId}'`,
      { indexName: payload.indexName, jobId: payload.jobId },
    )
  }
  const source = record.sourceGeneration
  const assignment = await leadingAssignment(deps.writeDeps, source, payload.partitionId)
  setReshardBlock(state, source, payload.jobId, payload.partitionId)
  await enqueuePartitionWrite(deps.writeDeps.partitionWriteQueues, source, payload.partitionId, async () => undefined)
  return forwardableEnd(deps.writeDeps.getReplicationLog(source, payload.partitionId), assignment.primaryTerm)
}
