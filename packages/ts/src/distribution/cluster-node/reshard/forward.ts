import { ErrorCodes, NarsilError } from '../../../errors'
import { chunkByBudget } from '../../chunking'
import { exchangeRebalanceMessage } from '../../cluster/rebalance/reply'
import { WIRE_BATCH_BUDGET } from '../../constants'
import { isRecord } from '../../payload-guards'
import type {
  ReshardForwardOperation,
  ReshardForwardPayload,
  ReshardPurgePayload,
} from '../../transport/reshard-payloads'
import { ClusterMessageTypes } from '../../transport/types'
import { resolvePartitionId, type WriteRoutingDeps } from '../write-routing'
import { resolveNodeTargets } from '../write-routing/assignment'
import type { ReshardCopyJob } from './state'

async function generationPrimaries(deps: WriteRoutingDeps, job: ReshardCopyJob): Promise<Map<number, string>> {
  let table = await deps.coordinator.getAllocation(job.targetGeneration)
  if ((table === null || table.assignments.size !== job.targetPartitionCount) && deps.refreshAllocation) {
    table = await deps.refreshAllocation(job.targetGeneration)
  }
  const primaries = new Map<number, string>()
  for (let partitionId = 0; partitionId < job.targetPartitionCount; partitionId++) {
    const primary = table?.assignments.get(partitionId)?.primary ?? null
    if (primary === null) {
      throw new NarsilError(
        ErrorCodes.PARTITION_UNASSIGNED,
        `Partition ${partitionId} of index '${job.targetGeneration}' has no primary to copy documents into`,
        { indexName: job.targetGeneration, partitionId },
      )
    }
    primaries.set(partitionId, primary)
  }
  return primaries
}

async function sendToGenerationPrimary(
  deps: WriteRoutingDeps,
  primary: string,
  type: string,
  payload: ReshardForwardPayload | ReshardPurgePayload,
): Promise<Record<string, unknown>> {
  return exchangeRebalanceMessage({
    transport: deps.transport,
    senderId: deps.nodeId,
    targets: await resolveNodeTargets(primary, deps),
    type,
    payload,
    failureMessage: `Node '${primary}' did not answer ${type} for index '${payload.targetGeneration}'`,
    details: { indexName: payload.targetGeneration, primaryNodeId: primary },
  })
}

function assertEveryOperationApplied(reply: Record<string, unknown>, sent: ReshardForwardOperation[], primary: string) {
  const results = Array.isArray(reply.results) ? reply.results : []
  if (results.length !== sent.length) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Node '${primary}' answered ${results.length} of ${sent.length} copied documents`,
      { primaryNodeId: primary },
    )
  }
  for (const result of results) {
    const answer = isRecord(result) ? result : {}
    if (answer.success === true) continue
    const code = typeof answer.errorCode === 'string' ? answer.errorCode : ErrorCodes.REPLICATION_ENTRY_INVALID
    const message = typeof answer.errorMessage === 'string' ? answer.errorMessage : 'a copied document was refused'
    throw new NarsilError(code, message, { primaryNodeId: primary })
  }
}

export async function forwardToGeneration(
  deps: WriteRoutingDeps,
  job: ReshardCopyJob,
  operations: ReshardForwardOperation[],
): Promise<void> {
  if (operations.length === 0) return
  const primaries = await generationPrimaries(deps, job)
  const byPrimary = new Map<string, ReshardForwardOperation[]>()
  for (const operation of operations) {
    const primary = primaries.get(resolvePartitionId(operation.documentId, job.targetPartitionCount))
    if (primary === undefined) continue
    const grouped = byPrimary.get(primary) ?? []
    grouped.push(operation)
    byPrimary.set(primary, grouped)
  }
  await Promise.all(
    [...byPrimary].map(async ([primary, grouped]) => {
      const chunks = chunkByBudget(grouped, {
        ...WIRE_BATCH_BUDGET,
        payloadBytesOf: operation => operation.document?.byteLength ?? 0,
      })
      for (const chunk of chunks) {
        const reply = await sendToGenerationPrimary(deps, primary, ClusterMessageTypes.RESHARD_FORWARD, {
          targetGeneration: job.targetGeneration,
          jobId: job.jobId,
          sourcePartitionId: job.partitionId,
          sourcePrimaryTerm: job.primaryTerm,
          operations: chunk,
        })
        assertEveryOperationApplied(reply, chunk, primary)
      }
    }),
  )
}

export async function purgeGeneration(deps: WriteRoutingDeps, job: ReshardCopyJob): Promise<void> {
  const primaries = new Set((await generationPrimaries(deps, job)).values())
  await Promise.all(
    [...primaries].map(primary =>
      sendToGenerationPrimary(deps, primary, ClusterMessageTypes.RESHARD_PURGE, {
        targetGeneration: job.targetGeneration,
        jobId: job.jobId,
        sourcePartitionCount: job.sourcePartitionCount,
        sourcePartitionId: job.partitionId,
      }),
    ),
  )
}
