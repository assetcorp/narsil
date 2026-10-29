import { describeError, ErrorCodes, NarsilError } from '../../../errors'
import { RESHARD_FORWARD_BATCH_DOCUMENTS } from '../../cluster/constants'
import { buildEntry } from '../../replication/entry-checksum'
import type { ReplicationLogEntry } from '../../replication/types'
import type {
  ReshardForwardOperation,
  ReshardForwardPayload,
  ReshardPurgePayload,
} from '../../transport/reshard-payloads'
import type { ForwardBatchOperationResult } from '../../transport/types'
import { noteLedTerm } from '../led-term'
import type { ClusterLocalEngine } from '../local-engine'
import { resolvePartitionId, type WriteRoutingDeps } from '../write-routing'
import { enqueuePartitionWrite } from '../write-routing/partition-queue'
import { chunkReplicationEntries, replicateEntryBatch } from '../write-routing/replication'
import { leadingAssignment } from './leadership'
import { jobKey } from './state'

export type ReshardTargetEngine = Pick<ClusterLocalEngine, 'applyReplicationEntries' | 'listPartitions'>

interface QueuedOperation {
  operation: ReshardForwardOperation
  position: number
}

function succeeded(documentId: string): ForwardBatchOperationResult {
  return { documentId, success: true, errorCode: null, errorMessage: null }
}

function failed(documentId: string, error: unknown): ForwardBatchOperationResult {
  const narsil = error instanceof NarsilError ? error : null
  return {
    documentId,
    success: false,
    errorCode: narsil?.code ?? ErrorCodes.REPLICATION_ENTRY_INVALID,
    errorMessage: describeError(error),
    errorDetails: null,
  }
}

async function applyInPartition(
  deps: WriteRoutingDeps,
  engine: ReshardTargetEngine,
  indexName: string,
  partitionId: number,
  queued: QueuedOperation[],
  results: ForwardBatchOperationResult[],
): Promise<void> {
  try {
    await enqueuePartitionWrite(deps.partitionWriteQueues, indexName, partitionId, async () => {
      const assignment = await leadingAssignment(deps, indexName, partitionId)
      const log = deps.getReplicationLog(indexName, partitionId)
      noteLedTerm(log, assignment.primaryTerm)
      const applied: Array<{ entry: ReplicationLogEntry }> = []
      let remaining = queued
      while (remaining.length > 0) {
        const run: Array<{ queued: QueuedOperation; entry: ReplicationLogEntry }> = []
        for (const item of remaining) {
          try {
            const entry = buildEntry({
              seqNo: log.localLogEnd + run.length + 1,
              primaryTerm: assignment.primaryTerm,
              operation: item.operation.operation === 'replace' ? 'INDEX' : 'DELETE',
              partitionId,
              indexName,
              documentId: item.operation.documentId,
              document: item.operation.operation === 'replace' ? (item.operation.document ?? null) : null,
            })
            log.assertFits(entry)
            run.push({ queued: item, entry })
          } catch (error) {
            results[item.position] = failed(item.operation.documentId, error)
          }
        }
        const outcome = await engine.applyReplicationEntries(run.map(item => item.entry))
        for (const { queued: item, entry } of run.slice(0, outcome.applied)) {
          log.appendCommitted(entry)
          applied.push({ entry })
          results[item.position] = succeeded(item.operation.documentId)
        }
        const stopped = run[outcome.applied]
        if (stopped !== undefined) {
          results[stopped.queued.position] = failed(stopped.queued.operation.documentId, outcome.error)
        }
        remaining = run.slice(outcome.applied + 1).map(item => item.queued)
      }
      const indexUuid = (await deps.coordinator.getAllocation(indexName))?.indexUuid
      for (const chunk of chunkReplicationEntries(applied)) {
        await replicateEntryBatch(
          chunk.map(item => item.entry),
          assignment,
          deps,
          indexUuid,
        )
      }
    })
  } catch (error) {
    for (const { operation, position } of queued) {
      if (results[position]?.success !== false) results[position] = failed(operation.documentId, error)
    }
  }
}

async function generationPartitionCount(deps: WriteRoutingDeps, indexName: string): Promise<number> {
  let table = await deps.coordinator.getAllocation(indexName)
  if ((table === null || table.assignments.size === 0) && deps.refreshAllocation !== undefined) {
    table = await deps.refreshAllocation(indexName)
  }
  if (table === null || table.assignments.size === 0) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' has no allocation table`, { indexName })
  }
  return table.assignments.size
}

async function applyOperations(
  deps: WriteRoutingDeps,
  engine: ReshardTargetEngine,
  indexName: string,
  operations: ReshardForwardOperation[],
): Promise<ForwardBatchOperationResult[]> {
  const partitionCount = await generationPartitionCount(deps, indexName)
  const byPartition = new Map<number, QueuedOperation[]>()
  operations.forEach((operation, position) => {
    const partitionId = resolvePartitionId(operation.documentId, partitionCount)
    const queued = byPartition.get(partitionId) ?? []
    queued.push({ operation, position })
    byPartition.set(partitionId, queued)
  })
  const results: ForwardBatchOperationResult[] = new Array(operations.length)
  await Promise.all(
    [...byPartition].map(([partitionId, queued]) =>
      applyInPartition(deps, engine, indexName, partitionId, queued, results),
    ),
  )
  return results
}

export function applyReshardForward(
  deps: WriteRoutingDeps,
  engine: ReshardTargetEngine,
  payload: ReshardForwardPayload,
): Promise<ForwardBatchOperationResult[]> {
  const state = deps.reshard
  if (state !== undefined) {
    const key = jobKey(payload.jobId, payload.sourcePartitionId)
    const accepted = state.acceptedTerms.get(key) ?? 0
    if (payload.sourcePrimaryTerm < accepted) {
      throw new NarsilError(
        ErrorCodes.REPLICATION_TERM_MISMATCH,
        `Partition ${payload.sourcePartitionId} sent copied documents under term ${payload.sourcePrimaryTerm}, below term ${accepted}`,
        { jobId: payload.jobId, sourcePartitionId: payload.sourcePartitionId, acceptedTerm: accepted },
      )
    }
    state.acceptedTerms.set(key, payload.sourcePrimaryTerm)
  }
  return applyOperations(deps, engine, payload.targetGeneration, payload.operations)
}

export async function purgeReshardSource(
  deps: WriteRoutingDeps,
  engine: ReshardTargetEngine,
  payload: ReshardPurgePayload,
): Promise<number> {
  const table = await deps.coordinator.getAllocation(payload.targetGeneration)
  let removed = 0
  for (const [partitionId, assignment] of table?.assignments ?? []) {
    if (assignment.primary !== deps.nodeId) continue
    let cursor: string | undefined
    do {
      const page = await engine.listPartitions(
        payload.targetGeneration,
        { limit: RESHARD_FORWARD_BATCH_DOCUMENTS, document: false, ...(cursor === undefined ? {} : { cursor }) },
        [partitionId],
      )
      const removals: ReshardForwardOperation[] = page.documents
        .filter(listed => resolvePartitionId(listed.id, payload.sourcePartitionCount) === payload.sourcePartitionId)
        .map(listed => ({ documentId: listed.id, operation: 'remove' }))
      const results = await applyOperations(deps, engine, payload.targetGeneration, removals)
      const failure = results.find(result => !result.success)
      if (failure !== undefined) {
        throw new NarsilError(
          failure.errorCode ?? ErrorCodes.REPLICATION_ENTRY_INVALID,
          failure.errorMessage ?? `Document '${failure.documentId}' could not be removed`,
          { indexName: payload.targetGeneration, documentId: failure.documentId },
        )
      }
      removed += removals.length
      cursor = page.cursor ?? undefined
    } while (cursor !== undefined)
  }
  return removed
}
