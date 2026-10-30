import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import {
  createAckMessage,
  createForwardBatchResultMessage,
  validateEntryBatchPayload,
  validateEntryPayload,
  validateForwardBatchPayload,
} from '../../replication/codec'
import { validateReplicationEntry } from '../../replication/replica'
import type { ReplicationLog, ReplicationLogEntry } from '../../replication/types'
import type { ForwardPayload, RespondFn, TransportMessage } from '../../transport/types'
import { ReplicationMessageTypes } from '../../transport/types'
import { noteAcceptedPrimaryTerm, noteSupersedingPrimary } from '../led-term'
import { holdsAnotherIndex } from '../request-identity'
import { applyForwardedBatch, applyForwardedWrite } from '../write-routing'
import { enqueuePartitionWrite } from '../write-routing/partition-queue'
import { resolveValidatedAssignment } from './entry-authority'
import type { DataNodeHandlerDeps } from './types'

export async function handleForward(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as Record<string, unknown>
  const payload = validateForwardPayload(decoded)
  const heldIndexUuid = deps.engine.indexUuidOf(payload.indexName)
  if (typeof heldIndexUuid === 'string' && holdsAnotherIndex(heldIndexUuid, payload.indexUuid)) {
    throw anotherIndexAsPrimary(payload.indexName, deps.nodeId, heldIndexUuid)
  }
  const documentId = await applyForwardedWrite(payload, deps.writeDeps)

  await respond({
    type: ReplicationMessageTypes.FORWARD,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode({ documentId, success: true }),
  })
}

export async function handleForwardBatch(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateForwardBatchPayload(decode(message.payload))
  const heldIndexUuid = deps.engine.indexUuidOf(payload.indexName)
  if (typeof heldIndexUuid === 'string' && holdsAnotherIndex(heldIndexUuid, payload.indexUuid)) {
    const refusal = anotherIndexAsPrimary(payload.indexName, deps.nodeId, heldIndexUuid)
    const results = payload.operations.map(operation => ({
      documentId: operation.documentId,
      success: false,
      errorCode: refusal.code,
      errorMessage: refusal.message,
      errorDetails: refusal.details,
    }))
    await respond(createForwardBatchResultMessage({ results }, deps.nodeId, message.requestId))
    return
  }
  const results = await applyForwardedBatch(payload, deps.writeDeps)
  await respond(createForwardBatchResultMessage({ results }, deps.nodeId, message.requestId))
}

export async function handleReplicationEntry(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateEntryPayload(decode(message.payload))
  const { entry } = payload
  refuseAnotherIndex(entry.indexName, payload.indexUuid, deps)

  await applyEntriesFromPrimary([entry], message.sourceId, deps, payload.previousPrimaryTerm)

  await respond(createAckMessage(entry.seqNo, entry.partitionId, entry.indexName, deps.nodeId, message.requestId))
}

export async function handleReplicationEntryBatch(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validateEntryBatchPayload(decode(message.payload))
  const lastEntry = payload.entries[payload.entries.length - 1]
  refuseAnotherIndex(lastEntry.indexName, payload.indexUuid, deps)

  await applyEntriesFromPrimary(payload.entries, message.sourceId, deps, payload.previousPrimaryTerm)

  await respond(
    createAckMessage(lastEntry.seqNo, lastEntry.partitionId, lastEntry.indexName, deps.nodeId, message.requestId),
  )
}

function anotherIndexAsPrimary(indexName: string, nodeId: string, heldIndexUuid: string): NarsilError {
  return new NarsilError(
    ErrorCodes.PARTITION_NOT_PRIMARY,
    `Node '${nodeId}' holds another index named '${indexName}', so it leads no partition of the index the sender routes to`,
    { indexName, localNodeId: nodeId, heldIndexUuid },
  )
}

export function refuseAnotherIndex(indexName: string, indexUuid: string | undefined, deps: DataNodeHandlerDeps): void {
  if (!holdsAnotherIndex(deps.engine.indexUuidOf(indexName), indexUuid)) return
  throw new NarsilError(
    ErrorCodes.INDEX_NOT_FOUND,
    `Node '${deps.nodeId}' holds no copy of the index '${indexName}' that the primary replicates, only an earlier index of that name`,
    { indexName, localNodeId: deps.nodeId },
  )
}

async function applyEntriesFromPrimary(
  entries: readonly ReplicationLogEntry[],
  sourceNodeId: string,
  deps: DataNodeHandlerDeps,
  previousPrimaryTerm: number | undefined,
): Promise<void> {
  const first = entries[0]
  if (first === undefined) return
  const assignment = await resolveValidatedAssignment(first, sourceNodeId, deps)
  noteSupersedingPrimary(
    deps.writeDeps.getReplicationLog(first.indexName, first.partitionId),
    first.indexName,
    first.partitionId,
    sourceNodeId,
    assignment.primaryTerm,
  )
  await enqueuePartitionWrite(deps.writeDeps.partitionWriteQueues, first.indexName, first.partitionId, async () => {
    const current = await resolveValidatedAssignment(first, sourceNodeId, deps)
    noteAcceptedPrimaryTerm(deps.writeDeps.getReplicationLog(first.indexName, first.partitionId), current.primaryTerm)
    await applyEntriesInLogOrder(first, entries, deps, previousPrimaryTerm)
  })
}

async function applyEntriesInLogOrder(
  first: ReplicationLogEntry,
  entries: readonly ReplicationLogEntry[],
  deps: DataNodeHandlerDeps,
  previousPrimaryTerm: number | undefined,
): Promise<void> {
  let log = deps.writeDeps.getReplicationLog(first.indexName, first.partitionId)
  let tailSeqNo = log.localLogEnd
  let tailPrimaryTerm = log.localLogEndPrimaryTerm
  let expectedPreviousTerm = previousPrimaryTerm
  const run: ReplicationLogEntry[] = []
  for (const entry of entries) {
    const expectedTermBefore = expectedPreviousTerm
    expectedPreviousTerm = entry.primaryTerm
    const existing = log.getEntry(entry.seqNo)
    if (existing !== undefined) {
      if (existing.checksum !== entry.checksum) {
        await applyRun(run, log, deps)
        throw new NarsilError(
          ErrorCodes.REPLICATION_ENTRY_INVALID,
          `Conflicting replication entry at sequence number ${entry.seqNo}`,
          { indexName: entry.indexName, partitionId: entry.partitionId, seqNo: entry.seqNo },
        )
      }
      continue
    }

    const heldTermBefore = run.at(-1)?.primaryTerm ?? (tailSeqNo === 0 ? 0 : log.termAt(tailSeqNo))
    if (
      entry.seqNo === tailSeqNo + 1 &&
      expectedTermBefore !== undefined &&
      heldTermBefore !== undefined &&
      heldTermBefore !== expectedTermBefore
    ) {
      await applyRun(run, log, deps)
      throw new NarsilError(
        ErrorCodes.REPLICATION_ENTRY_INVALID,
        `Replication entry ${entry.seqNo} follows an entry of term ${expectedTermBefore}, but this copy holds sequence number ${tailSeqNo} under term ${heldTermBefore}`,
        {
          indexName: entry.indexName,
          partitionId: entry.partitionId,
          seqNo: entry.seqNo,
          previousPrimaryTerm: expectedTermBefore,
          heldPrimaryTerm: heldTermBefore,
        },
      )
    }

    const expectedSeqNo = tailSeqNo + 1
    if (entry.seqNo !== expectedSeqNo) {
      const canSeedFromCompletedBootstrap =
        run.length === 0 &&
        log.entryCount === 0 &&
        entry.seqNo > expectedSeqNo &&
        deps.isBootstrapSynced?.(entry.indexName, entry.partitionId) === true

      if (!canSeedFromCompletedBootstrap) {
        await applyRun(run, log, deps)
        throw new NarsilError(
          ErrorCodes.REPLICATION_ENTRY_INVALID,
          `Out-of-order replication entry ${entry.seqNo}; expected ${expectedSeqNo}`,
          { indexName: entry.indexName, partitionId: entry.partitionId, seqNo: entry.seqNo, expectedSeqNo },
        )
      }

      deps.writeDeps.resetReplicationLog(entry.indexName, entry.partitionId, entry.seqNo, entry.primaryTerm)
      log = deps.writeDeps.getReplicationLog(entry.indexName, entry.partitionId)
      tailPrimaryTerm = log.localLogEndPrimaryTerm
    }

    const validation = validateReplicationEntry(entry, tailPrimaryTerm, log)
    if (!validation.valid) {
      await applyRun(run, log, deps)
      throw new NarsilError(
        validation.error ?? ErrorCodes.REPLICATION_ENTRY_INVALID,
        `Invalid replication entry ${entry.seqNo}`,
        { indexName: entry.indexName, partitionId: entry.partitionId, seqNo: entry.seqNo },
      )
    }
    run.push(entry)
    tailSeqNo = entry.seqNo
    tailPrimaryTerm = entry.primaryTerm
  }
  await applyRun(run, log, deps)
}

async function applyRun(
  run: readonly ReplicationLogEntry[],
  log: ReplicationLog,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  if (run.length === 0) return
  const { applied, error } = await deps.engine.applyReplicationEntries(run)
  for (let position = 0; position < applied; position++) log.appendCommitted(run[position])
  if (applied < run.length) throw error
}

export function validateForwardPayload(decoded: unknown): ForwardPayload {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: expected an object')
  }
  const record = decoded as Record<string, unknown>
  if (typeof record.indexName !== 'string' || record.indexName.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: "indexName" must be a non-empty string')
  }
  if (typeof record.documentId !== 'string' || record.documentId.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: "documentId" must be a non-empty string')
  }
  if (record.operation !== 'insert' && record.operation !== 'remove' && record.operation !== 'update') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Invalid ForwardPayload: "operation" must be "insert", "remove", or "update"',
    )
  }
  const indexUuid = record.indexUuid
  if (indexUuid !== undefined && indexUuid !== null && (typeof indexUuid !== 'string' || indexUuid.length === 0)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: "indexUuid" must be a non-empty string')
  }
  return decoded as unknown as ForwardPayload
}
