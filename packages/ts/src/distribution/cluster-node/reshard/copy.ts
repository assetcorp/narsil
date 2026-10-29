import { NarsilError } from '../../../errors'
import { encodeDocument } from '../../../serialization/document-encoding'
import { RESHARD_FORWARD_BATCH_DOCUMENTS, RESHARD_RETRY_DELAY_MS } from '../../cluster/constants'
import { pause } from '../../cluster/rebalance/pause'
import { readRebalanceProgress, writeRebalanceProgress } from '../../cluster/rebalance/records'
import type { ReshardForwardOperation } from '../../transport/reshard-payloads'
import type { ClusterLocalEngine } from '../local-engine'
import type { WriteRoutingDeps } from '../write-routing'
import { enqueuePartitionWrite } from '../write-routing/partition-queue'
import { forwardToGeneration, purgeGeneration } from './forward'
import { forwardableEnd } from './leadership'
import type { ReshardCopyJob } from './state'

export interface ReshardSourceDeps {
  writeDeps: WriteRoutingDeps
  engine: ClusterLocalEngine
  onError?: (error: unknown) => void
}

export interface CopyPosition {
  snapshotSeqNo: number
  forwardedSeqNo: number
  reportedLastSeqNo: number
}

interface SnapshotPage {
  cursor: string | null
  operations: ReshardForwardOperation[]
}

export async function stillLeading(deps: ReshardSourceDeps, job: ReshardCopyJob): Promise<boolean> {
  const table = await deps.writeDeps.coordinator.getAllocation(job.sourceGeneration)
  const assignment = table?.assignments.get(job.partitionId)
  return assignment?.primary === deps.writeDeps.nodeId && assignment.primaryTerm === job.primaryTerm
}

export async function retrying(
  deps: ReshardSourceDeps,
  job: ReshardCopyJob,
  work: () => Promise<void>,
): Promise<boolean> {
  let reportedCode: string | null = null
  while (!job.stopped) {
    try {
      await work()
      return true
    } catch (error) {
      if (!(await stillLeading(deps, job).catch(() => true))) {
        job.stopped = true
        return false
      }
      const code = error instanceof NarsilError ? error.code : String(error)
      if (code !== reportedCode) {
        reportedCode = code
        deps.onError?.(error)
      }
      await deps.writeDeps.refreshAllocation?.(job.targetGeneration).catch(() => null)
      await pause(RESHARD_RETRY_DELAY_MS)
    }
  }
  return false
}

export async function recordProgress(
  deps: ReshardSourceDeps,
  job: ReshardCopyJob,
  position: CopyPosition,
  lastSeqNo: number,
): Promise<void> {
  const written = await writeRebalanceProgress(deps.writeDeps.coordinator, job.indexName, job.partitionId, {
    jobId: job.jobId,
    primaryTerm: job.primaryTerm,
    snapshotSeqNo: position.snapshotSeqNo,
    forwardedSeqNo: position.forwardedSeqNo,
    sourceLastSeqNo: lastSeqNo,
  })
  if (!written) {
    job.stopped = true
    return
  }
  position.reportedLastSeqNo = lastSeqNo
}

export async function resumePosition(deps: ReshardSourceDeps, job: ReshardCopyJob): Promise<CopyPosition | null> {
  const progress = await readRebalanceProgress(deps.writeDeps.coordinator, job.indexName, job.partitionId)
  if (progress === null || progress.jobId !== job.jobId) return null
  const log = deps.writeDeps.getReplicationLog(job.sourceGeneration, job.partitionId)
  const next = progress.forwardedSeqNo + 1
  if (log.localLogEnd < progress.forwardedSeqNo) return null
  if (next <= log.localLogEnd && log.getEntry(next) === undefined) return null
  const position: CopyPosition = {
    snapshotSeqNo: progress.snapshotSeqNo,
    forwardedSeqNo: progress.forwardedSeqNo,
    reportedLastSeqNo: -1,
  }
  await recordProgress(deps, job, position, forwardableEnd(log, job.primaryTerm))
  return job.stopped ? null : position
}

function readSnapshotPage(
  deps: ReshardSourceDeps,
  job: ReshardCopyJob,
  cursor: string | undefined,
  onFirstPage: (snapshotSeqNo: number) => void,
): Promise<SnapshotPage> {
  const { writeDeps, engine } = deps
  return enqueuePartitionWrite(writeDeps.partitionWriteQueues, job.sourceGeneration, job.partitionId, async () => {
    if (cursor === undefined) {
      onFirstPage(forwardableEnd(writeDeps.getReplicationLog(job.sourceGeneration, job.partitionId), job.primaryTerm))
    }
    const listed = await engine.listPartitions(
      job.sourceGeneration,
      { limit: RESHARD_FORWARD_BATCH_DOCUMENTS, document: false, ...(cursor === undefined ? {} : { cursor }) },
      [job.partitionId],
    )
    const ids = listed.documents.map(document => document.id)
    const stored = await engine.getMultiple(job.sourceGeneration, ids)
    const operations: ReshardForwardOperation[] = []
    for (const id of ids) {
      const document = stored.get(id)
      if (document !== undefined)
        operations.push({ documentId: id, operation: 'replace', document: encodeDocument(document) })
    }
    return { cursor: listed.cursor, operations }
  })
}

export async function copySnapshot(
  deps: ReshardSourceDeps,
  job: ReshardCopyJob,
  announce: (snapshotSeqNo: number) => void,
): Promise<CopyPosition | null> {
  if (!(await retrying(deps, job, () => purgeGeneration(deps.writeDeps, job)))) return null
  let snapshotSeqNo = 0
  let cursor: string | undefined
  do {
    let page: SnapshotPage = { cursor: null, operations: [] }
    const pageCursor = cursor
    const read = await retrying(deps, job, async () => {
      page = await readSnapshotPage(deps, job, pageCursor, seqNo => {
        snapshotSeqNo = seqNo
      })
    })
    if (!read) return null
    announce(snapshotSeqNo)
    const operations = page.operations
    if (!(await retrying(deps, job, () => forwardToGeneration(deps.writeDeps, job, operations)))) return null
    cursor = page.cursor ?? undefined
  } while (cursor !== undefined)

  const position: CopyPosition = { snapshotSeqNo, forwardedSeqNo: snapshotSeqNo, reportedLastSeqNo: -1 }
  const log = deps.writeDeps.getReplicationLog(job.sourceGeneration, job.partitionId)
  await recordProgress(deps, job, position, forwardableEnd(log, job.primaryTerm))
  return job.stopped ? null : position
}
